'use strict';

function Event(eventType) {
  this.type = eventType;
}

/**
 *
 *
 * @param {*} eventType - 事件类型
 * @param {*} canBubble - 是否可以冒泡
 * @param {*} cancelable - 是否可以撤销
 * @returns
 */
Event.prototype.initEvent = function(eventType, canBubble, cancelable) {
  this.type = eventType;
  this.bubbles = canBubble;
  this.cancelable = cancelable;
  this.timeStamp = +new Date();
  return this;
};

Event.prototype.stopPropagation = function() {};
Event.prototype.preventDefault = function() {};

Event.CAPTURING_PHASE = 1;
Event.AT_TARGET = 2;
Event.BUBBLING_PHASE = 3;

module.exports = Event;
