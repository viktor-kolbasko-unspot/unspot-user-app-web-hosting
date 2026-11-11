'use strict';

(() => {
  const form = document.getElementById('probe-form');
  const runButton = document.getElementById('run-probe');
  const clearButton = document.getElementById('clear-probe');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const summary = document.getElementById('summary');
  const checkNames = ['resolver', 'login', 'me', 'mercure-token', 'mercure-open', 'mercure-message'];
  const fixedApiOrigin = 'https://uit-dev-products.unspot.tech';
  const fixedAuthOrigin = 'https://auth-dev.unspot.tech';
  let generation = 0;
  let requestController = null;
  let eventSource = null;
  let streamTimer = null;

  function status(name, state, text) {
    const element = document.getElementById(`check-${name}`);
    element.dataset.state = state;
    element.textContent = text;
  }

  function closeStream() {
    if (eventSource) eventSource.close();
    eventSource = null;
    if (streamTimer !== null) clearTimeout(streamTimer);
    streamTimer = null;
  }

  function reset() {
    generation += 1;
    if (requestController) requestController.abort();
    requestController = null;
    closeStream();
    usernameInput.value = '';
    passwordInput.value = '';
    runButton.disabled = false;
    checkNames.forEach((name) => status(name, 'idle', 'Не проверено'));
    summary.textContent = 'Проверка ещё не запускалась.';
  }

  function safeBase(value, expectedOrigin) {
    const url = new URL(value);
    if (url.origin !== expectedOrigin || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('configuration');
    }
    return url.origin;
  }

  async function requestJson(url, options = {}) {
    const controller = requestController;
    if (!controller) throw new DOMException('Stopped', 'AbortError');
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(url, {
        ...options,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`http-${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function errorText(error) {
    if (/^http-\d{3}$/.test(error.message)) return `Ошибка HTTP ${error.message.slice(5)}.`;
    if (error.name === 'AbortError') return 'Превышено время ожидания или проверка остановлена.';
    if (error.message === 'configuration') return 'Некорректная конфигурация адресов.';
    return 'Запрос не выполнен. Проверьте доступность сервера и разрешение запросов из браузера.';
  }

  function observeMercure(config, token, currentGeneration) {
    if (!config.privateMercureUrl) {
      status('mercure-open', 'blocked', 'Не проверено: адрес сервера обновлений не задан.');
      status('mercure-message', 'blocked', 'Не проверено: нет соединения.');
      summary.textContent = 'Проверка неполная: настройте адрес сервера обновлений.';
      return;
    }
    let url;
    try {
      url = new URL(config.privateMercureUrl);
      const allowedOrigins = config.allowedMercureOrigins;
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
          !Array.isArray(allowedOrigins) || !allowedOrigins.includes(url.origin)) {
        throw new Error('configuration');
      }
    } catch {
      status('mercure-open', 'blocked', 'Не проверено: некорректная конфигурация сервера обновлений.');
      status('mercure-message', 'blocked', 'Не проверено: нет соединения.');
      summary.textContent = 'Проверка неполная: проверьте конфигурацию.';
      return;
    }
    url.searchParams.set('topic', `tenant-${config.tenant}`);
    url.searchParams.set('authorization', token);
    status('mercure-open', 'running', 'Подключение…');
    status('mercure-message', 'running', 'Ожидание события, до 45 секунд…');
    eventSource = new EventSource(url.toString(), { withCredentials: false });
    eventSource.onopen = () => {
      if (generation !== currentGeneration) return;
      status('mercure-open', 'pass', 'Соединение открыто.');
      summary.textContent = 'Соединение открыто. Ожидается безопасное событие из тестового сценария.';
    };
    eventSource.onmessage = () => {
      if (generation !== currentGeneration) return;
      status('mercure-message', 'pass', 'Событие получено; содержимое не сохранялось.');
      summary.textContent = 'Все проверки пройдены. Соединение закрыто.';
      closeStream();
    };
    eventSource.onerror = () => {
      if (generation !== currentGeneration) return;
      status('mercure-open', 'fail', 'Ошибка соединения.');
      status('mercure-message', 'blocked', 'Доставка событий не подтверждена.');
      summary.textContent = 'Проверка обновлений не пройдена. Соединение закрыто.';
      closeStream();
    };
    streamTimer = setTimeout(() => {
      if (generation !== currentGeneration) return;
      if (eventSource?.readyState !== EventSource.OPEN) status('mercure-open', 'fail', 'Соединение не открыто за время проверки.');
      status('mercure-message', 'blocked', 'За время проверки событие не получено.');
      summary.textContent = 'Доставка обновлений не подтверждена. Соединение закрыто.';
      closeStream();
    }, 45000);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (runButton.disabled) return;
    const credentials = { username: usernameInput.value.trim(), password: passwordInput.value };
    reset();
    const currentGeneration = generation;
    requestController = new AbortController();
    runButton.disabled = true;
    summary.textContent = 'Проверка выполняется…';
    let activeCheck = 'resolver';
    let accessToken = null;
    try {
      const config = await requestJson('./config.json');
      if (generation !== currentGeneration) return;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.tenant)) throw new Error('configuration');
      const api = safeBase(config.apiBaseUrl, fixedApiOrigin);
      const auth = safeBase(config.authBaseUrl, fixedAuthOrigin);
      status('resolver', 'running', 'Проверка…');
      const resolver = new URL('/api/resolve-company-by-domain', auth);
      resolver.searchParams.set('subDomain', config.tenant);
      const company = await requestJson(resolver, { headers: { 'Accept-Language': 'ru' } });
      if (!company.body || typeof company.body !== 'object' || Array.isArray(company.body) ||
          typeof company.body.id !== 'string' || !company.body.id || company.body.subDomain !== config.tenant) {
        throw new Error('response');
      }
      if (generation !== currentGeneration) return;
      status('resolver', 'pass', 'Компания определена.');

      activeCheck = 'login';
      status(activeCheck, 'running', 'Проверка…');
      const login = await requestJson(`${api}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Language': 'ru' },
        body: JSON.stringify(credentials),
      });
      credentials.username = '';
      credentials.password = '';
      if (generation !== currentGeneration) return;
      if (typeof login.token !== 'string' || !login.token) {
        status(activeCheck, 'blocked', 'Токен не получен. Возможно, требуется дополнительный шаг входа.');
        summary.textContent = 'Проверка не завершена: вход не дал токен доступа.';
        return;
      }
      accessToken = login.token;
      login.token = null;
      login.refresh_token = null;
      status(activeCheck, 'pass', 'Вход выполнен.');

      activeCheck = 'me';
      status(activeCheck, 'running', 'Проверка…');
      const me = await requestJson(`${api}/api/me`, { headers: { Authorization: `Bearer ${accessToken}`, 'Accept-Language': 'ru' } });
      if (!me.body || typeof me.body !== 'object' || Array.isArray(me.body) ||
          typeof me.body.id !== 'string' || !me.body.id) throw new Error('response');
      if (generation !== currentGeneration) return;
      status(activeCheck, 'pass', 'Данные текущего пользователя доступны.');

      activeCheck = 'mercure-token';
      status(activeCheck, 'running', 'Проверка…');
      const mercure = await requestJson(`${api}/api/auth/mercure-token`, { headers: { Authorization: `Bearer ${accessToken}`, 'Accept-Language': 'ru' } });
      accessToken = null;
      if (!mercure.body || typeof mercure.body.token !== 'string' || !mercure.body.token) throw new Error('response');
      if (generation !== currentGeneration) return;
      status(activeCheck, 'pass', 'Токен обновлений получен.');
      observeMercure(config, mercure.body.token, currentGeneration);
      mercure.body.token = null;
    } catch (error) {
      if (generation !== currentGeneration) return;
      status(activeCheck, 'fail', errorText(error));
      summary.textContent = 'Проверка не пройдена. Непроверенные шаги не считаются успешными.';
    } finally {
      credentials.username = '';
      credentials.password = '';
      accessToken = null;
      if (generation === currentGeneration) {
        requestController = null;
        runButton.disabled = false;
      }
    }
  });
  clearButton.addEventListener('click', reset);
  window.addEventListener('pagehide', reset);
})();
