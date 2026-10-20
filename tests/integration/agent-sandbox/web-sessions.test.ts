/** 拼装页面在隔离标签页上下文中的交互回归。
 * 执行实际内联脚本，用最小 DOM、存储、锁和服务替身观察结果。
 * 替身不实现完整浏览器，因此布局、键盘和屏幕阅读器仍需另测。
 * 每个标签页拥有独立 VM 和元素表，刷新时可复用同一存储对象。
 * SSE 内容可由场景注入，区分已完成、超限和意外中断。
 * 页面定时等待用于替身异步交付，不用于证明后端队列顺序。
 * 关闭页面释放模拟租约与通道，防止测试间共享锁状态。
 * 页面入口通过实际表单和按钮处理器触发，不直接调用内部函数。
 * 请求路径与确认 body 单独记录，验证消息发往正确会话和动作。
 * 存储复制与普通刷新分开模拟，因为二者的独占锁状态不同。
 * 过期响应应终止操作，不能自动把有副作用请求转发到新会话。
 * SSE 终态决定增量是否可视为完整结果，断流路径单独验证。
 * 执行成功但生成超限时保留已执行提示，避免误导用户重新操作。
 * 忙碌状态测试在未完成操作期间主动触发周期状态刷新。
 * 确认控件同时检查禁用状态与处理器是否拒绝继续发送请求。
 * 存储不可用场景覆盖初始化失败，而非仅覆盖已建立会话的过期。
 * 输出检查面向用户可见气泡，不记录或暴露真实 sessionId。
 * Mock DOM 的 remove 不实现完整节点移除，不应据此断言布局效果。
 * 无障碍语义、真实焦点及窄屏布局不由这些 VM 测试证明。
 * 会话列表与切换复用真实列表、恢复和锁入口，验证来回提问路径。
 * 切换失败场景保持当前会话，绝不把副作用请求转发到目标会话。
 * 替身服务端区分列表、创建、恢复和删除，摘要内容确定可断言。
 * 历史回放断言聚合用户与助手消息，覆盖两种渲染出口。
 * 本地历史清理断言直接检查持久存储键，不依赖页面内部状态。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { loadSandboxPage } from '../../../examples/agent-sandbox/src/page-template.js';

/** 页面实际访问的最小元素集合。
 * children 保留插入顺序，便于检查确认框及消息气泡层次。
 * disabled 和事件处理器分别保存，使测试能尝试禁用后的点击。
 * innerHTML 置空时同步清空 children，与浏览器重置容器行为一致。
 * 不模拟浏览器布局、焦点、HTML 解析或自动阻止禁用按钮点击。
 * 因此禁用安全断言也检查脚本处理器自身不会发出确认请求。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
class Element {
  public children: Element[] = []; public textContent = ''; public className = '';
  public disabled = false; public value = ''; public style = { cssText: '' }; public scrollTop = 0; public scrollHeight = 0;
  public onclick: (() => void) | undefined; public onsubmit: ((event: { preventDefault: () => void }) => void) | undefined;
  private html = '';
  public get innerHTML(): string { return this.html; }
  public set innerHTML(value: string) { this.html = value; if (value === '') this.children = []; }
  public appendChild(child: Element): void { this.children.push(child); }
  public remove(): void {}
}

/** 模拟每个标签页的 sessionStorage，并支持复制标签页快照。
 * clone 复制值而非共享 Map，反映新标签页可能继承初始存储。
 * 不可用存储场景通过子类抛错，验证页面失败时的恢复提示。
 * length 与 key 模拟同源持久存储枚举，供历史淘汰逻辑使用。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
class Storage {
  public constructor(public values = new Map<string, string>()) {}
  public get length(): number { return this.values.size; }
  public key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  public getItem(key: string): string | null { return this.values.get(key) ?? null; }
  public setItem(key: string, value: string): void { this.values.set(key, value); }
  public removeItem(key: string): void { this.values.delete(key); }
  public clone(): Storage { return new Storage(new Map(this.values)); }
}

/** 模拟同源标签页广播，避免发送者收到自己的消息。
 * 异步交付使复制标签页能够模拟真实跨上下文消息竞争。
 * close 移除接收者，刷新后不会保留旧标签页的通道监听。
 * 该替身不验证浏览器具体调度或消息结构克隆实现。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
class Channel {
  public static members = new Set<Channel>();
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public constructor(_name: string) { Channel.members.add(this); }
  public postMessage(data: unknown): void {
    for (const member of Channel.members) if (member !== this) setTimeout(() => member.onmessage?.({ data }), 160);
  }
  public close(): void { Channel.members.delete(this); }
}

const heldLocks = new Map<string, symbol>();

type TestServer = { calls: string[]; bodies: string[]; ids: Set<string>; fetch: typeof fetch };
/** 记录会话请求并返回可配置的状态快照及 SSE 流。
 * 创建会话生成不同标识；删除标识可模拟过期或服务重启。
 * 摘要列表按创建顺序返回全部已知会话，恢复入口单独识别。
 * 确认请求体单独记录，供断言用户看到的 actionId 被提交。
 * @param pending - 状态响应中的待确认动作，默认无动作
 * @param stream - chat SSE 响应，默认是正常结束的澄清结果
 * @returns 可由页面调用的 fetch 替身及请求记录
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function makeServer(pending: object | null = null, stream = 'data: {"type":"done","result":{"status":"clarification","reply":"ok"}}\n\ndata: {"type":"end"}\n\n'): TestServer {
  const calls: string[] = []; const bodies: string[] = []; const ids = new Set<string>(); let next = 0;
  const summaries = new Map<string, string>();
  const state = { mode: 'scripted', context: { route: {}, workflow: { status: 'idle', currentStep: 'start' } }, events: [], pending };
  const fakeFetch = async (input: string | URL | Request, options?: RequestInit): Promise<Response> => {
    const path = String(input); calls.push(`${options?.method ?? 'GET'} ${path}`); if (path.includes('/confirm')) bodies.push(String(options?.body));
    if (path === '/api/sessions' || path.startsWith('/api/sessions?')) {
      // 带分页参数的 GET 返回全部已知摘要；POST 才创建新会话。
      if ((options?.method ?? 'GET') === 'GET') return Response.json({ sessions: [...ids].map((id) => ({ sessionId: id, summary: summaries.get(id) })) });
      const sessionId = String(++next).padStart(32, 'a'); ids.add(sessionId); summaries.set(sessionId, '会话摘要' + next);
      return Response.json({ sessionId }, { status: 201 });
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(.*?))?(?:\?.*)?$/.exec(path);
    if (match && !ids.has(match[1]!)) return Response.json({ status: 'failed', reasonCode: 'session_not_found' }, { status: 404 });
    if (match && match[2] === 'resume') return Response.json({ sessionId: match[1], resumed: true });
    if (match && options?.method === 'DELETE') { ids.delete(match[1]!); summaries.delete(match[1]!); return new Response(null, { status: 204 }); }
    if (path.includes('/state')) return Response.json(state);
    if (path.includes('/chat?')) return new Response(stream);
    if (path.includes('/compact')) return Response.json({ ok: false, reasonCode: 'insufficient_events' });
    return Response.json({ ok: true, status: 'cancelled', reply: 'ok' });
  };
  return { calls, bodies, ids, fetch: fakeFetch as typeof fetch };
}

/** 模拟标签页互斥租约；释放后刷新可恢复原会话。
 * 已持有的名称返回空锁，模拟 ifAvailable 的竞争失败。
 * Promise 完成时只释放自己的锁，避免新持有者被旧回调删除。
 * @param owner - 当前标签页的锁所有者
 * @returns 供页面使用的锁接口
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function makeNavigator(owner: symbol) {
  return { locks: { request: (name: string, _options: unknown, callback: (lock: object | null) => Promise<unknown> | void) => {
    if (heldLocks.has(name)) return Promise.resolve(callback(null));
    heldLocks.set(name, owner);
    return Promise.resolve(callback({ name })).finally(() => { if (heldLocks.get(name) === owner) heldLocks.delete(name); });
  } } };
}

/** 只模拟页面使用的 DOM，确认按钮查询仍按真实容器层次查找。
 * 未知 ID 按需创建，保证同一页面多次查询获得同一元素。
 * 会话列表按钮按容器内按钮收集，与确认框查询保持同一模式。
 * @param elements - 标签页独立元素表
 * @returns 供页面使用的文档接口
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function makeDocument(elements: Map<string, Element>) {
  return { getElementById: (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; },
    createElement: () => new Element(), querySelectorAll: (selector: string) => {
      const boxes = (elements.get('messages')?.children ?? []).filter((element) => element.className === 'confirm-box');
      if (selector === '.sessions-list button') return (elements.get('sessionsList')?.children ?? []).flatMap((item) => item.children);
      return selector === '.confirm-box button' ? boxes.flatMap((box) => box.children[2]?.children ?? []) : boxes;
    } };
}

/** 在独立上下文运行拼装后的页面，保留可手动触发的状态轮询。
 * 从最终 HTML 取脚本，覆盖真实的启动时片段组合顺序。
 * 模拟 setInterval 保存回调，测试可在请求阻塞期间主动触发刷新。
 * localStorage 与 sessionStorage 相互独立，历史只在同源存储内共享。
 * close 只回收本页面新增的通道与该 owner 持有的锁。
 * @param server - 模拟的会话 HTTP 服务
 * @param storage - 当前标签页的会话存储
 * @param navigationType - 页面导航类型，默认 navigate
 * @param windowName - 标签页 browsing context 名称
 * @param localStorage - 同源持久存储替身，默认新建
 * @returns 页面元素、轮询探针与清理函数
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function page(server: TestServer, storage: Storage, navigationType = 'navigate', windowName = '', localStorage = new Storage()): { elements: Map<string, Element>; tick: () => void; close: () => void; windowName: string } {
  const owner = Symbol('tab');
  const navigator = makeNavigator(owner);
  const elements = new Map<string, Element>();
  const document = makeDocument(elements);
  const html = loadSandboxPage();
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const channelsBefore = new Set(Channel.members);
  let tick = () => {};
  const performance = { getEntriesByType: () => [{ type: navigationType }] };
  const pageEvents = new Map<string, Array<() => void>>();
  const window = { name: windowName, addEventListener: (name: string, callback: () => void) => { const callbacks = pageEvents.get(name) ?? []; callbacks.push(callback); pageEvents.set(name, callbacks); } };
  runInNewContext(script, { document, navigator, fetch: server.fetch, sessionStorage: storage, localStorage, BroadcastChannel: Channel, performance, window, confirm: () => true,
    setTimeout, clearTimeout, setInterval: (callback: () => void) => { tick = callback; return 0; }, TextDecoder, console });
  return { elements, tick: () => tick(), get windowName() { return window.name; }, close: () => { for (const callback of pageEvents.get('pagehide') ?? []) callback(); for (const channel of Channel.members) if (!channelsBefore.has(channel)) channel.close(); for (const [name, holder] of heldLocks) if (holder === owner) heldLocks.delete(name); } };
}

/* 广播替身延迟交付；这个等待用于让页面异步初始化和消息处理完成。
 * 它不保证真实网络请求时序，后端并发测试使用独立事件探针。
 */
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 180));

/** 打开会话列表面板并等待列表加载完成。
 * 面板数据来自真实 GET 入口，替代直接调用内部函数。
 * @param tab - 已初始化的页面替身
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
async function openSessionsPanel(tab: ReturnType<typeof page>): Promise<void> {
  tab.elements.get('sessionsBtn')!.onclick!();
  await pause();
}

/** 在列表面板中找到摘要匹配的条目按钮。
 * 摘要在替身服务中有确定前缀，避免依赖会话标识的展示形式。
 * @param tab - 已初始化页面
 * @param summaryText - 条目摘要包含的文本
 * @returns 摘要命中的按钮
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
function sessionItemButton(tab: ReturnType<typeof page>, summaryText: string) {
  const items = tab.elements.get('sessionsList')!.children;
  const item = items.find((li) => li.children[0]?.textContent.includes(summaryText));
  assert.ok(item, `列表中应存在摘要含「${summaryText}」的会话`);
  return item.children[0]!;
}

/** 聚合替身 DOM 中元素对用户可见的文本。
 * 用户消息写在 textContent，助手消息渲染在子节点 innerHTML，需要合并判断。
 * @param element - 消息容器或子元素
 * @returns 可见文本的近似拼接
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
function visibleText(element: Element): string {
  return element.textContent + element.children.map((child) => child.textContent + child.innerHTML).join('');
}

/** 汇总消息区全部气泡的可见文本，用于跨角色断言。
 * @param tab - 已初始化页面
 * @returns 消息区可见文本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
function messagesText(tab: ReturnType<typeof page>): string {
  return tab.elements.get('messages')!.children.map(visibleText).join('\n');
}

/** 提交一条消息并等待流式回复与状态刷新完成。
 * 入口与真实用户一致，走表单处理器而不是内部函数。
 * @param tab - 已初始化页面
 * @param text - 用户消息
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
async function sendMessage(tab: ReturnType<typeof page>, text: string): Promise<void> {
  tab.elements.get('messageInput')!.value = text;
  tab.elements.get('inputBar')!.onsubmit!({ preventDefault() {} });
  await pause();
}

/* 两个普通标签页独立创建会话，聊天和压缩分别使用对应路径。
 * 确认请求路径中的 ID 与各自存储一致，避免落到旧共享入口。
 * 关闭第一个页面释放租约，再用同一存储模拟刷新。
 * 刷新后不应额外创建会话，而应读取原 sessionId 的状态。
 * 第二个标签页始终保留独立存储，不能因刷新而切换身份。
 * finally 分别关闭页面，确保锁和广播不污染后续场景。
 */
test('页面按标签隔离并在刷新时继续当前会话', async () => {
  const server = makeServer(); const firstStorage = new Storage(); const secondStorage = new Storage();
  const first = page(server, firstStorage); const second = page(server, secondStorage);
  try {
    await pause(); assert.equal(server.ids.size, 2);
    const firstId = [...firstStorage.values.values()][0]!; const secondId = [...secondStorage.values.values()][0]!;
    assert.notEqual(firstId, secondId);
    first.elements.get('messageInput')!.value = '你好';
    first.elements.get('inputBar')!.onsubmit!({ preventDefault() {} });
    second.elements.get('compactBtn')!.onclick!();
    await pause();
    assert.ok(server.calls.some((call) => call.includes(`/api/sessions/${firstId}/chat?stream=1`)));
    assert.ok(server.calls.some((call) => call.includes(`/api/sessions/${secondId}/compact`)));
    first.close(); const refreshed = page(server, firstStorage, 'reload', first.windowName);
    try { await pause(); assert.equal(server.ids.size, 2); assert.ok(server.calls.includes(`GET /api/sessions/${firstId}/state`)); }
    finally { refreshed.close(); }
  } finally { first.close(); second.close(); }
});

/* 复制存储模拟浏览器复制标签页时初始 sessionStorage 相同。
 * 原页面仍持有会话锁，副本不能把同一 ID 当作独占会话。
 * 第二页必须新建不同会话，服务侧最终有两个有效标识。
 * 分别关闭页面，确保每个标签只释放自己的通道与锁。
 * 该测试覆盖复制标签页，不代替真实浏览器兼容性验证。
 */
test('复制标签页不共享复制的会话标识', async () => {
  const server = makeServer(); const storage = new Storage(); const first = page(server, storage);
  try {
    await pause(); const copy = storage.clone(); const second = page(server, copy);
    try { await pause(); assert.equal(server.ids.size, 2); assert.notEqual([...storage.values.values()][0], [...copy.values.values()][0]); }
    finally { second.close(); }
  } finally { first.close(); }
});

/* 原标签页先关闭后复制页才初始化时，锁已释放但复制页仍是 navigate。
 * 导航类型必须阻止复用复制的 sessionStorage，不能只依赖锁竞争结果。
 */
test('原标签页关闭后复制标签页仍创建新会话', async () => {
  const server = makeServer(); const storage = new Storage(); const first = page(server, storage);
  await pause(); first.close();
  const copiedStorage = storage.clone(); const copy = page(server, copiedStorage);
  try { await pause(); assert.equal(server.ids.size, 2); assert.notEqual([...storage.values.values()][0], [...copiedStorage.values.values()][0]); }
  finally { copy.close(); }
});

/* 复制页尚未完成脚本初始化就被刷新时，没有当前标签页写入的 reload 标记。
 * 即使导航类型是 reload，也必须按新标签页创建会话，不能恢复复制来的旧 ID。
 */
test('复制页初始化前刷新也不恢复旧会话', async () => {
  const server = makeServer(); const originalStorage = new Storage(); const original = page(server, originalStorage);
  await pause(); const copiedStorage = originalStorage.clone(); original.close();
  const refreshedCopy = page(server, copiedStorage, 'reload');
  try { await pause(); assert.equal(server.ids.size, 2); assert.notEqual([...originalStorage.values.values()][0], [...copiedStorage.values.values()][0]); }
  finally { refreshedCopy.close(); }
});

/* 从服务替身移除已存储 ID，模拟会话过期或服务重启。
 * 发送可能有副作用的聊天后，页面须向用户明确提示过期。
 * 仅发生一次 chat 请求，不能自动新建会话后重试动作。
 * 发送按钮保持禁用，防止使用已经失效的本地会话标识。
 * 检查可见消息而非仅检查 HTTP 错误，保护用户可观察状态。
 */
test('会话过期时明确提示并阻止自动重试副作用', async () => {
  const server = makeServer(); const storage = new Storage(); const tab = page(server, storage);
  try {
    await pause(); const id = [...storage.values.values()][0]!; server.ids.delete(id);
    tab.elements.get('messageInput')!.value = '创建工单';
    tab.elements.get('inputBar')!.onsubmit!({ preventDefault() {} });
    await pause();
    assert.ok(tab.elements.get('messages')!.children.some((element) => element.textContent.includes('过期') || element.children.some((child) => child.innerHTML.includes('过期'))));
    assert.equal(server.calls.filter((call) => call.includes('/chat')).length, 1);
    assert.equal(tab.elements.get('sendBtn')!.disabled, true);
  } finally { tab.close(); }
});

/* 初始状态包含高风险 pending，页面恢复时应展示确认框。
 * 点击取消按钮后检查请求路径属于当前标签页的独立会话。
 * 请求体必须携带展示时看到的 actionId，不能只发送布尔选择。
 * 真实服务队列内的动作匹配由后端确认校验测试独立覆盖。
 * finally 关闭页面，释放保持会话独占的租约。
 */
test('恢复会话时展示待确认操作并发送到当前会话', async () => {
  const server = makeServer({ actionId: 'action', functionId: 'ticket.create', pluginId: 'ticket', riskLevel: 'high', input: {} });
  const storage = new Storage(); const tab = page(server, storage);
  try {
    await pause(); const id = [...storage.values.values()][0]!;
    const box = tab.elements.get('messages')!.children.find((element) => element.className === 'confirm-box');
    assert.ok(box);
    box.children[2]!.children[1]!.onclick!(); await pause();
    assert.ok(server.calls.includes(`POST /api/sessions/${id}/confirm`));
    assert.equal(JSON.parse(server.bodies[0]!).actionId, 'action');
  } finally { tab.close(); }
});

/* SSE 先返回私有增量，再以 executed 和超限原因结束。
 * 页面必须显示动作已执行及回复不完整，不能诱导用户重复动作。
 * 截断增量不能留在最终气泡中伪装成完整答案。
 * 只发送一次聊天请求，验证没有因为生成失败自动重试副作用。
 * 同时检查正文和元信息，让错误标记不只存在于不可见状态。
 */
test('已执行动作的超限流显示回复不完整而非截断正文', async () => {
  const stream = 'data: {"type":"delta","text":"partial-private"}\n\ndata: {"type":"done","result":{"status":"executed","reasonCode":"model_response_too_large","reply":"动作已执行，但回复不完整，请勿重复执行。"}}\n\ndata: {"type":"end"}\n\n';
  const server = makeServer(null, stream); const tab = page(server, new Storage());
  try {
    await pause(); tab.elements.get('messageInput')!.value = '列出任务';
    tab.elements.get('inputBar')!.onsubmit!({ preventDefault() {} }); await pause();
    const bubbles = tab.elements.get('messages')!.children;
    assert.ok(bubbles.some((bubble) => bubble.children.some((child) => child.innerHTML.includes('回复不完整'))));
    assert.ok(bubbles.some((bubble) => bubble.children.some((child) => child.textContent.includes('已执行') && child.textContent.includes('不完整'))));
    assert.ok(bubbles.every((bubble) => bubble.children.every((child) => !child.innerHTML.includes('partial-private'))));
    assert.equal(server.calls.filter((call) => call.includes('/chat')).length, 1);
  } finally { tab.close(); }
});

/* SSE 有增量但没有 done 或 end，模拟传输提前中断。
 * 页面应提示未完成，不能把已看到的部分当成最终完整回复。
 * 请求计数保持一次，网络异常不能自动重放可能已执行的动作。
 * 与上例不同，此路径没有服务端给出的明确动作终态。
 */
test('流在终态前中断时不把增量呈现为完整答复', async () => {
  const server = makeServer(null, 'data: {"type":"delta","text":"partial-private"}\n\n');
  const tab = page(server, new Storage());
  try {
    await pause(); tab.elements.get('messageInput')!.value = '列出任务';
    tab.elements.get('inputBar')!.onsubmit!({ preventDefault() {} }); await pause();
    assert.ok(tab.elements.get('messages')!.children.some((bubble) => bubble.children.some((child) => child.innerHTML.includes('未完成'))));
    assert.equal(server.calls.filter((call) => call.includes('/chat')).length, 1);
  } finally { tab.close(); }
});

/* 分别阻塞聊天、压缩和重置响应，模拟慢网络中的变更操作。
 * pending 已经展示，触发操作后立即检查旧确认按钮已禁用。
 * 手动触发轮询，再次检查状态刷新不能提前重新启用该按钮。
 * 模拟 DOM 不自动阻止 disabled 点击，因此仍直接调用处理器。
 * 确认请求体记录保持为空，证明脚本有额外的忙碌状态保护。
 * release 让操作及随后状态刷新完成，避免测试留下未结算请求。
 * finally 再次释放并关闭页面，覆盖断言失败时的清理路径。
 */
test('聊天、压缩、重置及其状态刷新期间确认控件保持禁用', async () => {
  for (const operation of ['chat', 'compact', 'reset']) {
    const server = makeServer({ actionId: 'action', functionId: 'ticket.create', pluginId: 'ticket', riskLevel: 'high', input: {} });
    const original = server.fetch; const release = Promise.withResolvers<Response>();
    server.fetch = async (input, options) => String(input).includes(`/${operation}`) ? release.promise : original(input, options);
    const tab = page(server, new Storage());
    try {
      await pause(); const box = tab.elements.get('messages')!.children.find((element) => element.className === 'confirm-box')!;
      const button = box.children[2]!.children[0]!;
      if (operation === 'chat') { tab.elements.get('messageInput')!.value = '你好'; tab.elements.get('inputBar')!.onsubmit!({ preventDefault() {} }); }
      else tab.elements.get(`${operation}Btn`)!.onclick!();
      assert.equal(button.disabled, true); tab.tick(); await pause();
      assert.equal(button.disabled, true); button.onclick!(); assert.equal(server.bodies.length, 0);
      release.resolve(operation === 'chat' ? new Response('data: {"type":"done","result":{"status":"clarification","reply":"ok"}}\n\ndata: {"type":"end"}\n\n') : Response.json({ ok: false }));
      await pause();
    } finally { release.resolve(Response.json({ ok: false })); tab.close(); }
  }
});

/* 模拟 sessionStorage 读取抛错，例如浏览器禁用存储的环境。
 * 页面不能退回共享兼容会话，而要提示无法建立独立会话。
 * 发送按钮保持禁用，防止错误恢复时向未知会话发出操作。
 * 此场景只验证存储失败，不假设用户已拥有可恢复的会话 ID。
 */
test('浏览器存储不可用时明确显示错误并保持禁用', async () => {
  class UnavailableStorage extends Storage { public override getItem(): string | null { throw new Error('unavailable'); } }
  const server = makeServer(); const tab = page(server, new UnavailableStorage());
  try {
    await pause();
    assert.equal(tab.elements.get('sendBtn')!.disabled, true);
    assert.ok(tab.elements.get('messages')!.children.some((element) => element.children.some((child) => child.innerHTML.includes('无法建立独立会话'))));
  } finally { tab.close(); }
});

/* 新会话已经在服务端创建后，sessionStorage 写入可能因配额失败。
 * 页面必须删除刚创建的服务端会话并释放锁，不能让容量泄漏到过期回收。
 */
test('会话标识写入失败时清理刚创建的服务端会话', async () => {
  class WriteFailStorage extends Storage { public override setItem(): void { throw new Error('quota'); } }
  const server = makeServer(); const tab = page(server, new WriteFailStorage());
  try {
    await pause();
    assert.ok(server.calls.some((call) => call.startsWith('DELETE /api/sessions/')));
    await pause(); assert.equal(server.ids.size, 0);
    assert.equal(tab.elements.get('sendBtn')!.disabled, true);
  } finally { tab.close(); }
});

/* 新建会话不再删除旧服务端会话，旧会话进入可切换列表。
 * 列表入口使用真实 GET 响应，当前会话在列表中高亮。
 * 删除请求不应再出现在新建路径中，旧标识仍由服务端持有。
 */
test('新建会话保留旧服务端会话并在列表中展示', async () => {
  const server = makeServer(); const storage = new Storage(); const tab = page(server, storage);
  try {
    await pause(); const firstId = [...storage.values.values()][0]!;
    tab.elements.get('newSessionBtn')!.onclick!();
    await pause();
    assert.ok(server.ids.has(firstId));
    assert.equal(server.calls.some((call) => call === `DELETE /api/sessions/${firstId}`), false);
    await openSessionsPanel(tab);
    assert.equal(tab.elements.get('sessionsList')!.children.length, 2);
    assert.ok(sessionItemButton(tab, '会话摘要2').textContent.includes('当前'));
  } finally { tab.close(); }
});

/* 在会话 A 提问后新建会话 B，再切回 A 时历史气泡被回放。
 * 切换使用真实恢复入口；切回后的新提问必须发往 A 而不是 B。
 * 回放内容来自本地持久存储，重放路径与实时渲染共用安全出口。
 */
test('切回旧会话回放历史且新提问发往该会话', async () => {
  const server = makeServer(); const storage = new Storage(); const tab = page(server, storage);
  try {
    await pause(); const firstId = [...storage.values.values()][0]!;
    await sendMessage(tab, '问题A');
    tab.elements.get('newSessionBtn')!.onclick!();
    await pause();
    await openSessionsPanel(tab);
    sessionItemButton(tab, '会话摘要1').onclick!();
    await pause();
    assert.ok(server.calls.includes(`POST /api/sessions/${firstId}/resume`));
    assert.ok(tab.elements.get('messages')!.children.some((element) => element.textContent.includes('问题A')));
    await sendMessage(tab, '跟进A');
    assert.ok(server.calls.some((call) => call.includes(`/api/sessions/${firstId}/chat?stream=1`)));
  } finally { tab.close(); }
});

/* 来回切换两个会话时，各自历史独立且提问发往当前会话。
 * 切到 B 时不能残留 A 的消息；再切回 A 时不能混入 B 的消息。
 * 每次切换都重新绑定输入与状态刷新到目标会话标识。
 */
test('来回切换会话时历史独立且请求路径正确', async () => {
  const server = makeServer(); const storage = new Storage(); const tab = page(server, storage);
  try {
    await pause();
    await sendMessage(tab, '问题A');
    tab.elements.get('newSessionBtn')!.onclick!();
    await pause();
    await openSessionsPanel(tab);
    sessionItemButton(tab, '会话摘要1').onclick!();
    await pause();
    await sendMessage(tab, '跟进A');
    sessionItemButton(tab, '会话摘要2').onclick!();
    await pause();
    assert.ok(!messagesText(tab).includes('问题A'));
    await sendMessage(tab, '问题B');
    const secondId = [...storage.values.values()][0]!;
    assert.ok(server.calls.some((call) => call.includes(`/api/sessions/${secondId}/chat?stream=1`)));
    sessionItemButton(tab, '会话摘要1').onclick!();
    await pause();
    const texts = messagesText(tab);
    assert.ok(texts.includes('问题A') && texts.includes('跟进A') && !texts.includes('问题B'));
  } finally { tab.close(); }
});

/* 目标会话被另一标签页持有时，切换被拒绝并提示。
 * 当前会话保持可用，用户仍能向自己的会话继续提问。
 * 被拒绝期间不触发目标会话的恢复请求。
 */
test('目标会话被其他标签页占用时切换被拒绝', async () => {
  const server = makeServer(); const first = page(server, new Storage());
  try {
    await pause();
    const secondStorage = new Storage();
    const second = page(server, secondStorage);
    try {
      await pause();
      await openSessionsPanel(second);
      sessionItemButton(second, '会话摘要1').onclick!();
      await pause();
      assert.ok(messagesText(second).includes('其他标签页'));
      assert.equal(server.calls.filter((call) => call.includes('/resume')).length, 0);
      const secondId = [...secondStorage.values.values()][0]!;
      await sendMessage(second, '自己的问题');
      assert.ok(server.calls.some((call) => call.includes(`/api/sessions/${secondId}/chat?stream=1`)));
    } finally { second.close(); }
  } finally { first.close(); }
});

/* 列表渲染后目标会话才不可恢复时，切换提示失败且留在当前会话。
 * resume 的 404 不能触发当前会话的过期处理。
 * 失败后当前会话仍可正常提问。
 */
test('切换目标不可恢复时提示失败并保持当前会话', async () => {
  const server = makeServer(); const storage = new Storage(); const tab = page(server, storage);
  try {
    await pause(); const firstId = [...storage.values.values()][0]!;
    await openSessionsPanel(tab);
    tab.elements.get('newSessionBtn')!.onclick!();
    await pause();
    server.ids.delete(firstId);
    sessionItemButton(tab, '会话摘要1').onclick!();
    await pause();
    assert.ok(messagesText(tab).includes('无法恢复'));
    const currentId = [...storage.values.values()][0]!;
    assert.notEqual(currentId, firstId);
    await sendMessage(tab, '继续提问');
    assert.ok(server.calls.some((call) => call.includes(`/api/sessions/${currentId}/chat?stream=1`)));
  } finally { tab.close(); }
});

/* 会话过期时本地历史一并清理，避免已死会话的聊天记录残留。
 * 过期仍只提示一次，且不允许继续操作。
 */
test('会话过期时清理本地历史记录', async () => {
  const server = makeServer(); const storage = new Storage(); const local = new Storage();
  const tab = page(server, storage, 'navigate', '', local);
  try {
    await pause(); const id = [...storage.values.values()][0]!;
    await sendMessage(tab, '遗留问题');
    assert.ok([...local.values.keys()].some((key) => key.includes(id)));
    server.ids.delete(id);
    await sendMessage(tab, '再试一次');
    await pause();
    assert.equal([...local.values.keys()].some((key) => key.includes(id)), false);
  } finally { tab.close(); }
});
