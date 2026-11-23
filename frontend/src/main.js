import './style.css';
import { createRouteMap } from './map.js';
import { orderActions, reconcileOrder, terminal } from './state.js';

const by = id => document.getElementById(id);
const places = [
  { label: '人民广场', longitude: 121.4750, latitude: 31.2304 },
  { label: '虹桥火车站', longitude: 121.3270, latitude: 31.1970 },
  { label: '陆家嘴', longitude: 121.5023, latitude: 31.2380 },
  { label: '徐家汇', longitude: 121.4376, latitude: 31.1950 },
];
const labels = {
  MATCHING: '正在匹配', ASSIGNED: '司机已接单', ARRIVED: '司机已到达',
  IN_PROGRESS: '行程中', COMPLETED: '已完成', CANCELED: '已取消', MATCH_FAILED: '匹配失败',
  PENDING: '等待回复', ACCEPTING: '确认接单中', ACCEPTED: '接单已确认',
  EXPIRED: '邀请已超时', VOID: '邀请已失效', REJECTED: '已拒单',
};
const state = {
  session: null, order: null, driver: null, offers: [], pendingOffer: null,
  history: [], historyCursor: null, quote: null, busy: false, refreshing: false,
  retryKeys: new Map(), historyWaiting: null,
};
let drawMap;
const money = cents => cents == null ? '—' : `¥${(cents / 100).toFixed(2)}`;
const kilometers = meters => meters == null ? '—' : `${(meters / 1000).toFixed(2)} 公里`;
const position = place => place ? `${place.longitude.toFixed(4)}, ${place.latitude.toFixed(4)}` : '—';
const endpoint = (id, action) => `/orders/${id}/${action}`;
const savedKey = id => `lab3-order:${id}`;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body, key, session = state.session } = {}) {
  const headers = {};
  if (session) headers.Authorization = `Bearer ${session.token}`;
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let result;
  try {
    result = await fetch('/api' + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5500),
    });
  } catch {
    throw new ApiError(0, '请求未收到响应，请稍后重试。');
  }
  const data = await result.json().catch(() => null);
  if (!result.ok || data === null) {
    const explanation = data?.error?.message;
    const local = {
      401: '登录已失效，请切换账号后重试。', 403: '当前账号没有操作权限。',
      404: '暂时查不到这笔记录。', 409: '订单或邀请状态已变化，请刷新后再操作。',
      502: '服务暂时不可用，请稍后重试。', 503: '服务暂时不可用，请稍后重试。',
    };
    throw new ApiError(result.status, local[result.status] || explanation || `请求失败（${result.status}）`);
  }
  return data;
}

async function command(path, body, method = 'POST') {
  const slot = `${method}:${path}:${JSON.stringify(body)}`;
  let key = state.retryKeys.get(slot);
  if (!key) {
    key = globalThis.crypto?.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
    state.retryKeys.set(slot, key);
  }
  try {
    const response = await api(path, { method, body, key });
    state.retryKeys.delete(slot);
    return response;
  } catch (error) {
    if (error.status > 0 && error.status < 500) state.retryKeys.delete(slot);
    throw error;
  }
}

function notify(message, isError = false) {
  by('notice').textContent = message;
  by('notice').classList.toggle('error', isError);
}
function report(error) {
  notify(error.message, true);
}
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label, fn, classes = 'secondary') {
  const node = el('button', label, classes);
  node.type = 'button';
  node.disabled = state.busy;
  node.addEventListener('click', fn);
  return node;
}
function routeText(item) {
  if (!item) return '—';
  return `${item.pickup?.label ?? '—'} → ${item.dropoff?.label ?? '—'}`;
}
function choice() {
  return { pickup: places[by('pickup').value], dropoff: places[by('dropoff').value] };
}

function remember(order) {
  state.order = reconcileOrder(state.order, order);
  if (state.session?.account.role === 'passenger' && state.order && terminal(state.order.status) &&
      !state.history.some(row => row.orderId === state.order.orderId)) state.historyWaiting = state.order.orderId;
  if (state.session && state.order) {
    sessionStorage.setItem(savedKey(state.session.account.id), JSON.stringify(state.order));
  }
}

function renderOffers() {
  const container = by('offers');
  if (!state.offers.length) {
    container.replaceChildren(el('p', state.pendingOffer ? '正在确认接单，请稍候。' : '暂无邀请。'));
    return;
  }
  container.replaceChildren(...state.offers.map(offer => {
    const item = el('article', undefined, 'list-card');
    item.append(el('strong', routeText(offer)),
      el('p', `${money(offer.estimatedFareCents)} · ${labels[offer.status] ?? offer.status}`),
      el('small', `截止 ${new Date(offer.expiresAt).toLocaleTimeString('zh-CN')}`));
    if (offer.status === 'PENDING') {
      const actions = el('div', undefined, 'controls');
      actions.append(button('接单', () => respond(offer, 'accept'), 'primary'),
        button('拒单', () => respond(offer, 'reject')));
      item.append(actions);
    }
    return item;
  }));
}

function renderOrder() {
  const item = state.order;
  const details = by('order');
  const actions = by('order-actions');
  by('order-badge').textContent = labels[item?.status] ?? '暂无订单';
  if (!item) {
    details.replaceChildren(el('p', '当前没有订单。'));
    actions.replaceChildren();
    return;
  }
  details.replaceChildren(el('p', routeText(item), 'route-name'),
    el('p', `${kilometers(item.distanceMeters ?? item.estimatedDistanceMeters)} · ${money(item.fareCents ?? item.estimatedFareCents)}`),
    el('small', `订单 ${item.orderId}`, 'order-id'));
  if (item.driverId) {
    const profile = item.driver?.displayName ?? (item.driverProfileStatus === 'UNAVAILABLE'
      ? '司机资料暂不可用' : `司机 ${item.driverId}`);
    details.append(el('p', profile, 'person'));
  }
  if (item.status === 'MATCH_FAILED') details.append(el('p', '本次没有匹配到司机，可以重新叫车。'));
  actions.replaceChildren(...orderActions(state.session.account.role, item.status)
    .map(([verb, label]) => button(label, () => changeOrder(item.orderId, verb), verb === 'cancel' ? 'secondary' : 'primary')));
}

function renderHistory() {
  const history = by('history');
  history.replaceChildren(...(state.history.length ? state.history.map(item => {
    const card = el('details', undefined, 'list-card');
    card.append(el('summary', `${routeText(item)} · ${labels[item.status] ?? item.status}`),
      el('p', `${kilometers(item.distanceMeters ?? item.estimatedDistanceMeters)} · ${money(item.fareCents ?? item.estimatedFareCents)}`),
      el('p', `司机 ${item.driverId ?? '未分配'} · ${dateTime(item.updatedAt)}`),
      el('small', item.orderId, 'order-id'));
    if (item.startedAt || item.finishedAt) {
      card.append(el('p', `上车 ${dateTime(item.startedAt)} · 结束 ${dateTime(item.finishedAt)}`));
    }
    card.open = expandedHistory.has(item.orderId);
    card.addEventListener('toggle', () => {
      if (card.open) expandedHistory.add(item.orderId);
      else expandedHistory.delete(item.orderId);
    });
    return card;
  }) : [el('p', '暂无历史订单。')]));
  by('history-more').hidden = !state.historyCursor;
  by('history-more').disabled = state.busy;
}
const expandedHistory = new Set();
const dateTime = value => value ? new Date(value).toLocaleString('zh-CN') : '—';

function render() {
  const account = state.session?.account;
  by('welcome').hidden = Boolean(account);
  by('desk').hidden = !account;
  by('identity').hidden = !account;
  if (!account) return;
  const driver = account.role === 'driver';
  by('account').textContent = account.displayName;
  by('desk-title').textContent = driver ? '司机工作台' : '乘客叫车台';
  by('desk-intro').textContent = driver ? '管理接单状态和当前行程。' : '选好起终点，查看本次行程。';
  by('driver-panel').hidden = !driver;
  by('offers-panel').hidden = !driver;
  by('passenger-panel').hidden = driver;
  by('history-panel').hidden = driver;
  by('refresh').disabled = state.busy || state.refreshing;
  const active = state.order && !terminal(state.order.status);
  if (driver) {
    const info = state.driver;
    by('driver-badge').textContent = info ? (info.online ? '在线' : '离线') : '读取中';
    by('driver-state').textContent = info?.currentOrderId ? '已有承接订单，下线后仍可完成这笔行程。'
      : info?.online ? '可接收新邀请。' : '上线后可接收新邀请。';
    by('driver-toggle').textContent = info?.online ? '暂停接单' : '上线接单';
    by('driver-toggle').disabled = state.busy || !info;
    renderOffers();
  } else {
    by('book').disabled = state.busy || Boolean(active);
    by('book').textContent = state.order && terminal(state.order.status) ? '重新叫车' : '发起叫车';
    by('estimate-btn').disabled = state.busy || Boolean(active);
    by('estimate').textContent = state.quote
      ? `预计 ${kilometers(state.quote.estimatedDistanceMeters)} · ${money(state.quote.estimatedFareCents)}`
      : '估价根据预设地点计算。';
  }
  renderOrder();
  const route = active ? state.order : driver ? (state.offers[0] ?? state.order) : choice();
  if (!drawMap) drawMap = createRouteMap(by('map'), by('map-status'), by('map-attribution'));
  drawMap(route?.pickup, route?.dropoff);
  const coords = by('map-coordinates');
  coords.replaceChildren(
    el('div', `上车点 · ${route?.pickup?.label ?? '未选择'} · ${position(route?.pickup)}`),
    el('div', `目的地 · ${route?.dropoff?.label ?? '未选择'} · ${position(route?.dropoff)}`));
}

let revision = 0;
async function sync({ manual = false } = {}) {
  const session = state.session;
  if (!session || state.refreshing || state.busy) return;
  state.refreshing = true;
  const version = revision;
  const before = state.order;
  const role = session.account.role;
  const isDriver = role === 'driver';
  const currentPath = isDriver ? '/drivers/me/order' : '/orders/current';
  const activeSession = () => state.session === session && revision === version;

  const readOrder = async () => {
    if (before && !terminal(before.status)) {
      try {
        return await api(`/orders/${before.orderId}`, { session });
      } catch (error) {
        if (error.status !== 404) throw error;
        // A successful write may be ahead of the read model.
        return null;
      }
    }
    return (await api(currentPath, { session })).order;
  };

  try {
    const tasks = [readOrder()];
    if (isDriver) {
      tasks.push(api('/drivers/me/status', { session }), api('/drivers/me/offers', { session }),
        state.pendingOffer ? api(`/offers/${state.pendingOffer}`, { session }) : Promise.resolve(null));
    }
    const results = await Promise.allSettled(tasks);
    if (!activeSession()) return;
    if (results[0].status === 'fulfilled') remember(results[0].value);
    if (isDriver) {
      if (results[1].status === 'fulfilled') state.driver = results[1].value;
      if (results[2].status === 'fulfilled') {
        state.offers = results[2].value.offers;
        state.pendingOffer ??= state.offers.find(offer => offer.status === 'ACCEPTING')?.offerId ?? null;
      }
      const pending = results[3].value;
      if (pending && pending.status !== 'ACCEPTING') {
        state.pendingOffer = null;
        if (pending.status === 'ACCEPTED') notify('接单已确认，正在刷新行程。');
        else notify(labels[pending.status] ?? '邀请已失效。', true);
      }
    } else if (state.historyWaiting) {
      await loadHistory();
    }

    const failure = results.find(result => result.status === 'rejected');
    if (failure && activeSession()) report(failure.reason);
    else if (manual && activeSession()) notify('状态已刷新。');
  } finally {
    if (state.session === session) {
      state.refreshing = false;
      render();
    }
  }
}

async function busy(action) {
  if (state.busy || !state.session) return;
  state.busy = true;
  revision++;
  render();
  try {
    await action();
  } catch (error) {
    report(error);
  } finally {
    state.busy = false;
    render();
    void sync();
  }
}

function changeOrder(id, verb) {
  return busy(async () => {
    const result = await command(endpoint(id, verb));
    remember(result);
    if (terminal(result.status)) {
      notify(verb === 'cancel' ? '订单已取消，可以重新叫车。' : '行程已完成。');
      if (state.session.account.role === 'passenger') void loadHistory();
    } else {
      notify(labels[result.status]);
    }
  });
}

function respond(offer, verb) {
  return busy(async () => {
    const result = await command(`/offers/${offer.offerId}/${verb}`);
    state.offers = state.offers.filter(item => item.offerId !== offer.offerId);
    if (verb === 'accept') {
      state.pendingOffer = offer.offerId;
      notify(result.status === 'ACCEPTED' ? '接单已确认，正在刷新行程。' : '已提交接单请求，等待确认。');
    } else {
      notify('已拒绝这条邀请。');
    }
  });
}

let historyRequest = 0;
async function loadHistory(more = false) {
  const session = state.session;
  if (session?.account.role !== 'passenger') return;
  const request = ++historyRequest;
  const cursor = more && state.historyCursor ? `&before=${encodeURIComponent(state.historyCursor)}` : '';
  try {
    const page = await api('/orders/history?limit=6' + cursor, { session });
    if (state.session !== session || request !== historyRequest) return;
    state.history = more ? [...state.history, ...page.orders] : page.orders;
    state.historyCursor = page.nextCursor;
    if (state.history.some(item => item.orderId === state.historyWaiting)) state.historyWaiting = null;
    renderHistory();
  } catch (error) {
    if (state.session === session && request === historyRequest) report(error);
  }
}

for (const [id, selected] of [['pickup', 0], ['dropoff', 1]]) {
  const select = by(id);
  select.replaceChildren(...places.map((place, index) => {
    const option = el('option', place.label);
    option.value = index;
    option.selected = index === selected;
    return option;
  }));
  select.addEventListener('change', () => {
    state.quote = null;
    render();
  });
}

let loggingIn = false;
function openSession(session) {
  state.session = session;
  try {
    state.order = JSON.parse(sessionStorage.getItem(savedKey(session.account.id)));
  } catch {
    state.order = null;
  }
  render();
  void sync();
  void loadHistory();
}
for (const node of document.querySelectorAll('[data-login]')) {
  node.addEventListener('click', async () => {
    if (loggingIn) return;
    loggingIn = true;
    by('login-message').textContent = '正在登录…';
    try {
      const login = await api('/auth/login', { method: 'POST', body: { accountId: node.dataset.login } });
      const session = { token: login.token, account: login.account, expiresAt: Date.now() + login.expiresIn * 1000 };
      sessionStorage.setItem('lab3-session', JSON.stringify(session));
      by('login-message').textContent = '';
      openSession(session);
    } catch (error) {
      by('login-message').textContent = error.message;
    } finally {
      loggingIn = false;
    }
  });
}
by('logout').addEventListener('click', () => {
  if (state.busy) return;
  revision++;
  sessionStorage.removeItem('lab3-session');
  state.session = state.order = state.driver = state.quote = state.pendingOffer = state.historyCursor = state.historyWaiting = null;
  state.offers = [];
  state.history = [];
  state.refreshing = false;
  state.retryKeys.clear();
  expandedHistory.clear();
  notify('');
  render();
});
by('refresh').addEventListener('click', () => { void sync({ manual: true }); });
by('history-refresh').addEventListener('click', () => { void loadHistory(); });
by('history-more').addEventListener('click', () => { void loadHistory(true); });
by('driver-toggle').addEventListener('click', () => void busy(async () => {
  state.driver = await command('/drivers/me/status', { online: !state.driver.online }, 'PUT');
  notify(state.driver.online ? '已上线。' : '已暂停接单。');
}));
by('estimate-btn').addEventListener('click', () => void busy(async () => {
  const data = choice();
  if (data.pickup === data.dropoff) return notify('上车点和目的地需要不同。', true);
  const estimate = await api('/orders/estimate', { method: 'POST', body: data });
  const current = choice();
  if (current.pickup === data.pickup && current.dropoff === data.dropoff) state.quote = estimate;
}));
by('book').addEventListener('click', () => void busy(async () => {
  const data = choice();
  if (data.pickup === data.dropoff) return notify('上车点和目的地需要不同。', true);
  remember(await command('/orders', data));
  notify('叫车已受理，正在寻找司机。');
}));
try {
  const stored = JSON.parse(sessionStorage.getItem('lab3-session'));
  if (stored?.token && stored?.account?.id && stored.expiresAt > Date.now()) openSession(stored);
} catch {
  sessionStorage.removeItem('lab3-session');
}
setInterval(() => void sync(), 2100);
