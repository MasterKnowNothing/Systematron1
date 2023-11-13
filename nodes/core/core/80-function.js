/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

const clone = require("clone");
const PayloadValidator = require("../../PayloadValidator");

module.exports = function (RED) {
  "use strict";
  var util = require("util");
  var vm2 = require("vm2");

  function sendResults(node, _msgid, msgs) {
    if (msgs == null) {
      return;
    } else if (!util.isArray(msgs)) {
      msgs = [msgs];
    }
    var msgCount = 0;
    for (var m = 0; m < msgs.length; m++) {
      if (msgs[m]) {
        if (!util.isArray(msgs[m])) {
          msgs[m] = [msgs[m]];
        }
        for (var n = 0; n < msgs[m].length; n++) {
          var msg = msgs[m][n];
          if (msg !== null && msg !== undefined) {
            if (
              typeof msg === "object" &&
              !Buffer.isBuffer(msg) &&
              !util.isArray(msg)
            ) {
              msg._msgid = _msgid;
              msgCount++;
            } else {
              var type = typeof msg;
              if (type === "object") {
                type = Buffer.isBuffer(msg)
                  ? "Buffer"
                  : util.isArray(msg)
                  ? "Array"
                  : "Date";
              }
              node.error(
                RED._("function.error.non-message-returned", { type: type })
              );
            }
          }
        }
      }
    }
    if (msgCount > 0) {
      node.send(msgs);
    }
  }

  function FunctionNode(n) {
    RED.nodes.createNode(this, n);
    var node = this;
    this.name = n.name;
    this.func = n.func;
    var functionText =
      "var results = null;" +
      "results = (function(msg){ " +
      "var __msgid__ = msg._msgid;" +
      "var node = {" +
      "log:__node__.log," +
      "error:__node__.error," +
      "warn:__node__.warn," +
      "debug:__node__.debug," +
      "trace:__node__.trace," +
      "on:__node__.on," +
      "status:__node__.status," +
      "send:function(msgs){ __node__.send(__msgid__,msgs);}" +
      "};\n" +
      this.func +
      "\n" +
      "})(msg);";
    this.topic = n.topic;
    this.outstandingTimers = [];
    this.outstandingIntervals = [];
    var sandbox = {
      console: console,
      util: util,
      //Buffer:Buffer,
      //Date: Date,
      RED: {
        util: RED.util,
      },
      __node__: {
        log: function () {
          node.log.apply(node, arguments);
        },
        error: function () {
          node.error.apply(node, arguments);
        },
        warn: function () {
          node.warn.apply(node, arguments);
        },
        debug: function () {
          node.debug.apply(node, arguments);
        },
        trace: function () {
          node.trace.apply(node, arguments);
        },
        send: function (id, msgs) {
          sendResults(node, id, msgs);
        },
        on: function () {
          if (arguments[0] === "input") {
            throw new Error(RED._("function.error.inputListener"));
          }
          node.on.apply(node, arguments);
        },
        status: function () {
          node.status.apply(node, arguments);
        },
      },
      context: {
        set: function () {
          node.context().set.apply(node, arguments);
        },
        get: function () {
          return node.context().get.apply(node, arguments);
        },
        keys: function () {
          return node.context().keys.apply(node, arguments);
        },
        get global() {
          return node.context().global;
        },
        get flow() {
          return node.context().flow;
        },
      },
      flow: {
        set: function () {
          node.context().flow.set.apply(node, arguments);
        },
        get: function () {
          return node.context().flow.get.apply(node, arguments);
        },
        keys: function () {
          return node.context().flow.keys.apply(node, arguments);
        },
      },
      // global: {
      //     set: function() {
      //         node.context().global.set.apply(node,arguments);
      //     },
      //     get: function() {
      //         return node.context().global.get.apply(node,arguments);
      //     },
      //     keys: function() {
      //         return node.context().global.keys.apply(node,arguments);
      //     }
      // },
      setTimeout: function () {
        var func = arguments[0];
        var timerId;
        arguments[0] = function () {
          sandbox.clearTimeout(timerId);
          try {
            func.apply(this, arguments);
          } catch (err) {
            node.error(err, {});
          }
        };
        timerId = setTimeout.apply(this, arguments);
        node.outstandingTimers.push(timerId);
        return timerId;
      },
      clearTimeout: function (id) {
        clearTimeout(id);
        var index = node.outstandingTimers.indexOf(id);
        if (index > -1) {
          node.outstandingTimers.splice(index, 1);
        }
      },
      setInterval: function () {
        var func = arguments[0];
        var timerId;
        arguments[0] = function () {
          try {
            func.apply(this, arguments);
          } catch (err) {
            node.error(err, {});
          }
        };
        timerId = setInterval.apply(this, arguments);
        node.outstandingIntervals.push(timerId);
        return timerId;
      },
      clearInterval: function (id) {
        clearInterval(id);
        var index = node.outstandingIntervals.indexOf(id);
        if (index > -1) {
          node.outstandingIntervals.splice(index, 1);
        }
      },
    };

    if (util.hasOwnProperty("promisify")) {
      sandbox.setTimeout[util.promisify.custom] = function (after, value) {
        return new Promise(function (resolve, reject) {
          sandbox.setTimeout(function () {
            resolve(value);
          }, after);
        });
      };
    }
    try {
      this.on("input", async function (msg) {
        try {
          const originalMessage = clone(msg);
          const payloadValidator = new PayloadValidator(msg, this.id);
          var start = process.hrtime();
          sandbox.msg = msg;
          const vm2Instance = new vm2.VM({ sandbox, timeout: 5000 });
          const beforeVm2 = process.hrtime();
          const result = vm2Instance.run(functionText);
          const afterVm2 = process.hrtime(beforeVm2);
          payloadValidator.verify(result);
          sendResults(this, msg._msgid, result);
          const logger = clone(msg.logger);
          let lambdaRequestId;
          let {
            payload: {
              system: { organization },
            },
            event: {
              workers: [{ id: workerId }],
            },
          } = originalMessage;

          const {
            settings: {
              api: { codefile = false },
            },
          } = RED;

          if (codefile) {
            workerId = workerId.split(":::")[0];
            const nodeId = this.id.split(`${organization}-${workerId}-`)[1];
            try {
              const messageToSend = clone(msg);
              delete messageToSend.logger;

              const beforeCodefile = process.hrtime();
              const {
                payload: {
                  result,
                  error
                },
                requestId
              }  = await codefile.run({ srcCode: this.func, context: { msg } });
      
              const afterCodefile = process.hrtime(beforeCodefile);

              const metrics = {
                lambdaRequestId: requestId,
                action:'codefile-success',
                organization,
                workerId: workerId,
                nodeId: nodeId,
                rawCode: this.func,
                vm2Runtime: `${
                  Math.floor((afterVm2[0] * 1e9 + afterVm2[1]) / 10000) / 100
                }ms`,
                codefileRuntime: `${
                  Math.floor(
                    (afterCodefile[0] * 1e9 + afterCodefile[1]) / 10000
                  ) / 100
                }ms`,
              };
              if(result){
                // not required right now since we dont go via this path
                // const responseMessage = result.msg
                // responseMessage.logger = logger;
                // payloadValidator.verify(responseMessage);
                // sendResults(this,msg._msgid, responseMessage);
              } 
              else{
                metrics.error = error;
                metrics.action = 'codefile-error';
              }
              logger.info(JSON.stringify(metrics, null, 2));
            } catch (e) {
              logger.error(e)
              logger.error({
                message: "Error running codefile",
                action:'codefile-error',
                error: e.message,
                organization,
                workerId: workerId,
                nodeId: nodeId,
                rawCode: this.func,
              });
            }
          }

          // sendResults(this,msg._msgid, responseMessage);
          var duration = process.hrtime(start);
          var converted =
            Math.floor((duration[0] * 1e9 + duration[1]) / 10000) / 100;
          this.metric("duration", msg, converted);
          if (process.env.NODE_RED_FUNCTION_TIME) {
            this.status({ fill: "yellow", shape: "dot", text: "" + converted });
          }
        } catch (err) {
          //remove unwanted part
          var index = err.stack.search(
            /\n\s*at ContextifyScript.Script.runInContext/
          );
          err.stack = err.stack
            .slice(0, index)
            .split("\n")
            .slice(0, -1)
            .join("\n");
          var stack = err.stack.split(/\r?\n/);

          //store the error in msg to be used in flows
          msg.error = err;

          var line = 0;
          var errorMessage;
          var stack = err.stack.split(/\r?\n/);
          if (stack.length > 0) {
            while (
              line < stack.length &&
              stack[line].indexOf("ReferenceError") !== 0
            ) {
              line++;
            }

            if (line < stack.length) {
              errorMessage = stack[line];
              var m = /:(\d+):(\d+)$/.exec(stack[line + 1]);
              if (m) {
                var lineno = Number(m[1]) - 1;
                var cha = m[2];
                errorMessage += " (line " + lineno + ", col " + cha + ")";
              }
            }
          }
          if (!errorMessage) {
            errorMessage = err.toString();
          }

          // gives access to the msg object in custom logger
          const temp = errorMessage;
          errorMessage = msg;
          errorMessage.toString = () => temp; // preserve original error message in logs
          msg.errorMessage = temp;

          this.error(errorMessage, msg);
        }
      });
      this.on("close", function () {
        while (node.outstandingTimers.length > 0) {
          clearTimeout(node.outstandingTimers.pop());
        }
        while (node.outstandingIntervals.length > 0) {
          clearInterval(node.outstandingIntervals.pop());
        }
        this.status({});
      });
    } catch (err) {
      // eg SyntaxError - which v8 doesn't include line number information
      // so we can't do better than this
      this.error(err);
    }
  }
  RED.nodes.registerType("function", FunctionNode);
  RED.library.register("functions");
};
