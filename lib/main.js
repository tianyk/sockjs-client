'use strict';

require('./shims');

var URL = require('url-parse')
  , inherits = require('inherits')
  , JSON3 = require('json3')
  , random = require('./utils/random')
  , escape = require('./utils/escape')
  , urlUtils = require('./utils/url')
  , eventUtils = require('./utils/event')
  , transport = require('./utils/transport')
  , objectUtils = require('./utils/object')
  , browser = require('./utils/browser')
  , log = require('./utils/log')
  , Event = require('./event/event')
  , EventTarget = require('./event/eventtarget')
  , loc = require('./location') // window.location
  , CloseEvent = require('./event/close')
  , TransportMessageEvent = require('./event/trans-message')
  , InfoReceiver = require('./info-receiver')
  ;

var debug = function () { };
if (process.env.NODE_ENV !== 'production') {
  debug = require('debug')('sockjs-client:main');
}

var transports;

// follow constructor steps defined at http://dev.w3.org/html5/websockets/#the-websocket-interface
/**
 *
 * @param {string} url - ws服务器地址 只支持 http(s) 协议
 * @param {*} protocols - 暂时没用 https://github.com/sockjs/sockjs-client/issues/425#issuecomment-379327707
 * @param {*} options - 
 * @returns
 */
function SockJS(url, protocols, options) {
  if (!(this instanceof SockJS)) {
    return new SockJS(url, protocols, options);
  }
  if (arguments.length < 1) {
    throw new TypeError("Failed to construct 'SockJS: 1 argument required, but only 0 present");
  }
  EventTarget.call(this);

  this.readyState = SockJS.CONNECTING;
  this.extensions = '';
  this.protocol = '';

  // non-standard extension
  options = options || {};
  if (options.protocols_whitelist) {
    log.warn("'protocols_whitelist' is DEPRECATED. Use 'transports' instead.");
  }
  // 支持的传输方式
  this._transportsWhitelist = options.transports;
  this._transportOptions = options.transportOptions || {};

  // protocol://domain/prefix/${server}/${sessionId}/websocket
  // sessionId 长度或者生成函数
  // 如果是自定义sessionId可以使用 sessionId: () => { return /* YOUR_SESSIONID */ }
  // new SockJS('http://127.0.0.1:3000/ws', null, { sessionId: () => 1000 });
  var sessionId = options.sessionId || 8;
  if (typeof sessionId === 'function') {
    this._generateSessionId = sessionId;
  } else if (typeof sessionId === 'number') {
    this._generateSessionId = function () {
      return random.string(sessionId);
    };
  } else {
    throw new TypeError('If sessionId is used in the options, it needs to be a number or a function.');
  }

  // server: server地址 可以换成房间号码
  // new SockJS('http://127.0.0.1:3000/ws', null, { sessionId: () => 1000, server: 100 });
  // 房间号 100 sessionId 1000
  this._server = options.server || random.numberString(1000);

  // Step 1 of WS spec - parse and validate the url. Issue #8
  var parsedUrl = new URL(url);
  if (!parsedUrl.host || !parsedUrl.protocol) {
    // 必须是一个有效的并且是绝对地址 /ws 这样是不行的
    throw new SyntaxError("The URL '" + url + "' is invalid");
  } else if (parsedUrl.hash) {
    // url不支持hash
    throw new SyntaxError('The URL must not contain a fragment');
  } else if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    // 支持http或者https协议
    throw new SyntaxError("The URL's scheme must be either 'http:' or 'https:'. '" + parsedUrl.protocol + "' is not allowed.");
  }

  var secure = parsedUrl.protocol === 'https:';
  // Step 2 - don't allow secure origin with an insecure protocol
  if (loc.protocol === 'https:' && !secure) {
    // 检查是否安全问题 如果所在页面是https的，通信协议也要是https的
    throw new Error('SecurityError: An insecure SockJS connection may not be initiated from a page loaded over HTTPS');
  }

  // Step 3 - check port access - no need here
  // Step 4 - parse protocols argument
  // protocols 暂时无用
  if (!protocols) {
    protocols = [];
  } else if (!Array.isArray(protocols)) {
    protocols = [protocols];
  }
  // protocols 暂时无用
  // Step 5 - check protocols argument
  var sortedProtocols = protocols.sort();
  sortedProtocols.forEach(function (proto, i) {
    if (!proto) {
      throw new SyntaxError("The protocols entry '" + proto + "' is invalid.");
    }
    if (i < (sortedProtocols.length - 1) && proto === sortedProtocols[i + 1]) {
      throw new SyntaxError("The protocols entry '" + proto + "' is duplicated.");
    }
  });

  // Step 6 - convert origin
  // 将 http://example.com/abc 解析为 http://example.com:80 形式
  // return p.protocol + '//' + p.hostname + ':' + port;
  var o = urlUtils.getOrigin(loc.href);
  this._origin = o ? o.toLowerCase() : null;

  // remove the trailing slash
  // 删除path最后的斜杠 http://example.com/abc/// => http://example.com/abc
  parsedUrl.set('pathname', parsedUrl.pathname.replace(/\/+$/, ''));

  // store the sanitized url
  // 返回清理后的url
  this.url = parsedUrl.href;
  debug('using url', this.url);

  // Step 7 - start connection in background
  // obtain server info
  // http://sockjs.github.io/sockjs-protocol/sockjs-protocol-0.3.3.html#section-26
  // 判断是否跨域 能否用xhr
  this._urlInfo = {
    nullOrigin: !browser.hasDomain()
    , sameOrigin: urlUtils.isOriginEqual(this.url, loc.href) // 是否同源
    , sameScheme: urlUtils.isSchemeEqual(this.url, loc.href) // 是否同协议
  };

  // 这里会先发起一个info请求
  this._ir = new InfoReceiver(this.url, this._urlInfo);
  this._ir.once('finish', this._receiveInfo.bind(this));
}

inherits(SockJS, EventTarget);

function userSetCode(code) {
  return code === 1000 || (code >= 3000 && code <= 4999);
}

SockJS.prototype.close = function (code, reason) {
  // Step 1
  if (code && !userSetCode(code)) {
    throw new Error('InvalidAccessError: Invalid code');
  }
  // Step 2.4 states the max is 123 bytes, but we are just checking length
  if (reason && reason.length > 123) {
    throw new SyntaxError('reason argument has an invalid length');
  }

  // Step 3.1
  if (this.readyState === SockJS.CLOSING || this.readyState === SockJS.CLOSED) {
    return;
  }

  // TODO look at docs to determine how to set this
  var wasClean = true;
  this._close(code || 1000, reason || 'Normal closure', wasClean);
};

/**
 * 只能发送 string 类型数据
 * 要自己判断readyState 是否是 open，关闭状态下并不会报错
 *
 * @param {string} data
 * @returns
 */
SockJS.prototype.send = function (data) {
  // #13 - convert anything non-string to string
  // TODO this currently turns objects into [object Object]
  if (typeof data !== 'string') {
    data = '' + data;
  }
  if (this.readyState === SockJS.CONNECTING) {
    throw new Error('InvalidStateError: The connection has not been established yet');
  }
  if (this.readyState !== SockJS.OPEN) {
    return;
  }
  this._transport.send(escape.quote(data));
};

SockJS.version = require('./version');

SockJS.CONNECTING = 0;
SockJS.OPEN = 1;
SockJS.CLOSING = 2;
SockJS.CLOSED = 3;

SockJS.prototype._receiveInfo = function (info, rtt) {
  // rtt 延迟时间 用于后面确定心跳检测间隔
  debug('_receiveInfo', rtt);
  this._ir = null;
  if (!info) {
    this._close(1002, 'Cannot connect to server');
    return;
  }

  // 往返超时
  // establish a round-trip timeout (RTO) based on the
  // round-trip time (RTT)
  this._rto = this.countRTO(rtt);
  // allow server to override url used for the actual transport
  // info 返回的base_url地址或者当前 url
  this._transUrl = info.base_url ? info.base_url : this.url;
  info = objectUtils.extend(info, this._urlInfo);
  debug('info', info);
  // determine list of desired and supported transports
  // 检查哪些传输方式可用
  var enabledTransports = transports.filterToEnabled(this._transportsWhitelist, info);
  // _transports 可用的协议
  this._transports = enabledTransports.main;
  debug(this._transports.length + ' enabled transports');

  this._connect();
};

SockJS.prototype._connect = function () {
  // 协议一个一个试
  for (var Transport = this._transports.shift(); Transport; Transport = this._transports.shift()) {
    debug('attempt', Transport.transportName);
    // jsonp iframe 等传输方式需要加载完成
    if (Transport.needBody) {
      if (!global.document.body ||
        (typeof global.document.readyState !== 'undefined' &&
          global.document.readyState !== 'complete' &&
          global.document.readyState !== 'interactive')) {
        debug('waiting for body');
        this._transports.unshift(Transport);
        eventUtils.attachEvent('load', this._connect.bind(this));
        return;
      }
    }

    // calculate timeout based on RTO and round trips. Default to 5s
    var timeoutMs = (this._rto * Transport.roundTrips) || 5000;
    // 连接超时设置
    this._transportTimeoutId = setTimeout(this._transportTimeout.bind(this), timeoutMs);
    debug('using timeout', timeoutMs);

    // 拼装url 
    var transportUrl = urlUtils.addPath(this._transUrl, '/' + this._server + '/' + this._generateSessionId());
    // 获取协议私有配置
    var options = this._transportOptions[Transport.transportName];
    debug('transport url', transportUrl);
    // 创建协议对象
    var transportObj = new Transport(transportUrl, this._transUrl, options);
    transportObj.on('message', this._transportMessage.bind(this));
    transportObj.once('close', this._transportClose.bind(this));
    transportObj.transportName = Transport.transportName;
    this._transport = transportObj;

    return;
  }
  this._close(2000, 'All transports failed', false);
};

// 连接超时
SockJS.prototype._transportTimeout = function () {
  debug('_transportTimeout');
  if (this.readyState === SockJS.CONNECTING) {
    if (this._transport) {
      this._transport.close();
    }

    this._transportClose(2007, 'Transport timed out');
  }
};

// 接收到消息
SockJS.prototype._transportMessage = function (msg) {
  debug('_transportMessage', msg);
  // 消息格式 type:[msg] 
  // type长度一位
  // - o 初始化连接
  // - h 心跳检测
  // - a 数组消息
  // - m 普通消息
  // -c close
  var self = this
    , type = msg.slice(0, 1)
    , content = msg.slice(1)
    , payload
    ;

  // 初始化和心跳检测消息直接跳过
  // first check for messages that don't need a payload
  switch (type) {
    case 'o':
      this._open();
      return;
    case 'h':
      this.dispatchEvent(new Event('heartbeat'));
      debug('heartbeat', this.transport);
      return;
  }

  // 解析消息
  if (content) {
    try {
      payload = JSON3.parse(content);
    } catch (e) {
      debug('bad json', content);
    }
  }

  // 空/不合法（json解析失败）消息
  if (typeof payload === 'undefined') {
    debug('empty payload', content);
    return;
  }


  switch (type) {
    case 'a':
      if (Array.isArray(payload)) {
        payload.forEach(function (p) {
          debug('message', self.transport, p);
          self.dispatchEvent(new TransportMessageEvent(p));
        });
      }
      break;
    case 'm':
      debug('message', this.transport, payload);
      this.dispatchEvent(new TransportMessageEvent(payload));
      break;
    case 'c':
      if (Array.isArray(payload) && payload.length === 2) {
        this._close(payload[0], payload[1], true);
      }
      break;
  }
};

// 关闭事件
SockJS.prototype._transportClose = function (code, reason) {
  debug('_transportClose', this.transport, code, reason);
  if (this._transport) {
    this._transport.removeAllListeners();
    this._transport = null;
    this.transport = null;
  }

  // 2000 表示所有协议均不可用
  // 重连
  if (!userSetCode(code) && code !== 2000 && this.readyState === SockJS.CONNECTING) {
    this._connect();
    return;
  }

  this._close(code, reason);
};

// 服务器响应 o 回调
// 执行一些列状态设置
SockJS.prototype._open = function () {
  debug('_open', this._transport.transportName, this.readyState);
  // 修改状态为 CONNECTING => OPEN 
  if (this.readyState === SockJS.CONNECTING) {
    // 清理超时定时器
    if (this._transportTimeoutId) {
      clearTimeout(this._transportTimeoutId);
      this._transportTimeoutId = null;
    }
    // 修改状态
    this.readyState = SockJS.OPEN;
    this.transport = this._transport.transportName;
    // 用户自己监听open事件
    this.dispatchEvent(new Event('open'));
    debug('connected', this.transport);
  } else {
    // The server might have been restarted, and lost track of our
    // connection.
    this._close(1006, 'Server lost session');
  }
};

// 关闭连接
/**
 *
 *
 * @param {*} code - 错误码 2000 所有都协议都失败 2007 连接超时 
 * @param {*} reason
 * @param {*} wasClean
 */
SockJS.prototype._close = function (code, reason, wasClean) {
  debug('_close', this.transport, code, reason, wasClean, this.readyState);
  var forceFail = false;

  if (this._ir) {
    forceFail = true;
    this._ir.close();
    this._ir = null;
  }
  if (this._transport) {
    this._transport.close();
    this._transport = null;
    this.transport = null;
  }

  if (this.readyState === SockJS.CLOSED) {
    throw new Error('InvalidStateError: SockJS has already been closed');
  }

  this.readyState = SockJS.CLOSING;
  setTimeout(function () {
    this.readyState = SockJS.CLOSED;

    if (forceFail) {
      this.dispatchEvent(new Event('error'));
    }

    var e = new CloseEvent('close');
    e.wasClean = wasClean || false;
    e.code = code || 1000;
    e.reason = reason;

    // 分发 close 事件
    this.dispatchEvent(e);
    this.onmessage = this.onclose = this.onerror = null;
    debug('disconnected');
  }.bind(this), 0);
};

// See: http://www.erg.abdn.ac.uk/~gerrit/dccp/notes/ccid2/rto_estimator/
// and RFC 2988.
// Retransmission TimeOut 重传超时时间
SockJS.prototype.countRTO = function (rtt) {
  // In a local environment, when using IE8/9 and the `jsonp-polling`
  // transport the time needed to establish a connection (the time that pass
  // from the opening of the transport to the call of `_dispatchOpen`) is
  // around 200msec (the lower bound used in the article above) and this
  // causes spurious timeouts. For this reason we calculate a value slightly
  // larger than that used in the article.
  if (rtt > 100) {
    return 4 * rtt; // rto > 400msec
  }
  return 300 + rtt; // 300msec < rto <= 400msec
};

module.exports = function (availableTransports) {
  transports = transport(availableTransports);
  require('./iframe-bootstrap')(SockJS, availableTransports);
  return SockJS;
};
