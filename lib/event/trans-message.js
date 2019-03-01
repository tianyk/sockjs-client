'use strict';

var inherits = require('inherits')
  , Event = require('./event')
  ;

// 消息事件
function TransportMessageEvent(data) {
  Event.call(this);
  this.initEvent('message', false, false);
  this.data = data;
}

inherits(TransportMessageEvent, Event);

module.exports = TransportMessageEvent;
