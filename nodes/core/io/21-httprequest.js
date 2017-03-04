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

module.exports = function(RED) {
    "use strict";
    var http = require("follow-redirects").http;
    var https = require("follow-redirects").https;
    var urllib = require("url");
    var mustache = require("mustache");
    var querystring = require("querystring");

    function HTTPRequest(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        var req;
        var nodeUrl = n.url;
        var isTemplatedUrl = (nodeUrl||"").indexOf("{{") != -1;
        var nodeMethod = n.method || "GET";
        if (n.tls) {
            var tlsNode = RED.nodes.getNode(n.tls);
        }
        this.ret = n.ret || "txt";
        if (RED.settings.httpRequestTimeout) { this.reqTimeout = parseInt(RED.settings.httpRequestTimeout) || 120000; }
        else { this.reqTimeout = 120000; }

        var prox, noprox;
        if (process.env.http_proxy != null) { prox = process.env.http_proxy; }
        if (process.env.HTTP_PROXY != null) { prox = process.env.HTTP_PROXY; }
        if (process.env.no_proxy != null) { noprox = process.env.no_proxy.split(","); }
        if (process.env.NO_PROXY != null) { noprox = process.env.NO_PROXY.split(","); }

        function handleMsg(msg) {
            if (node.metric()) {
                // Calculate request time
                var diff = process.hrtime(preRequestTimestamp);
                var ms = diff[0] * 1e3 + diff[1] * 1e-6;
                var metricRequestDurationMillis = ms.toFixed(3);
                node.metric("duration.millis", msg, metricRequestDurationMillis);
                if (res.client && res.client.bytesRead) {
                    node.metric("size.bytes", msg, res.client.bytesRead);
                }
            }
            if (node.ret === "txt") {
                msg.payload = msg.payload.toString();
            }
            else if (node.ret === "obj") {
                try { msg.payload = JSON.parse(msg.payload); }
                catch(e) { node.warn(RED._("httpin.errors.json-error")); }
            }
            node.send(msg);
            node.status({});
        }

        this.on("input",function(msg) {
            var boundary = "";
            var chunkBuffer = Buffer.from('');
            var headerBodySeparator = "";
            var preRequestTimestamp = process.hrtime();
            node.status({fill:"blue",shape:"dot",text:"httpin.status.requesting"});
            var url = nodeUrl || msg.url;
            if (msg.url && nodeUrl && (nodeUrl !== msg.url)) {  // revert change below when warning is finally removed
                node.warn(RED._("common.errors.nooverride"));
            }
            if (isTemplatedUrl) {
                url = mustache.render(nodeUrl,msg);
            }
            if (!url) {
                node.error(RED._("httpin.errors.no-url"),msg);
                return;
            }
            // url must start http:// or https:// so assume http:// if not set
            if (!((url.indexOf("http://") === 0) || (url.indexOf("https://") === 0))) {
                if (tlsNode) {
                    url = "https://"+url;
                } else {
                    url = "http://"+url;
                }
            }

            var method = nodeMethod.toUpperCase() || "GET";
            if (msg.method && n.method && (n.method !== "use")) {     // warn if override option not set
                node.warn(RED._("common.errors.nooverride"));
            }
            if (msg.method && n.method && (n.method === "use")) {
                method = msg.method.toUpperCase();          // use the msg parameter
            }
            var opts = urllib.parse(url);
            opts.method = method;
            opts.headers = {};
            opts.encoding = null; // response body should be buffer, not string
            var ctSet = "Content-Type"; // set default camel case
            var clSet = "Content-Length";
            if (msg.headers) {
                for (var v in msg.headers) {
                    if (msg.headers.hasOwnProperty(v)) {
                        var name = v.toLowerCase();
                        if (name !== "content-type" && name !== "content-length") {
                            // only normalise the known headers used later in this
                            // function. Otherwise leave them alone.
                            name = v;
                        }
                        else if (name === 'content-type') { ctSet = v; }
                        else { clSet = v; }
                        opts.headers[name] = msg.headers[v];
                    }
                }
            }
            if (this.credentials && this.credentials.user) {
                opts.auth = this.credentials.user+":"+(this.credentials.password||"");
            }
            var payload = null;

            if (msg.payload && (method == "POST" || method == "PUT" || method == "PATCH" ) ) {
                if (typeof msg.payload === "string" || Buffer.isBuffer(msg.payload)) {
                    payload = msg.payload;
                } else if (typeof msg.payload == "number") {
                    payload = msg.payload+"";
                } else {
                    if (opts.headers['content-type'] == 'application/x-www-form-urlencoded') {
                        payload = querystring.stringify(msg.payload);
                    } else {
                        payload = JSON.stringify(msg.payload);
                        if (opts.headers['content-type'] == null) {
                            opts.headers[ctSet] = "application/json";
                        }
                    }
                }
                if (opts.headers['content-length'] == null) {
                    if (Buffer.isBuffer(payload)) {
                        opts.headers[clSet] = payload.length;
                    } else {
                        opts.headers[clSet] = Buffer.byteLength(payload);
                    }
                }
            }
            // revert to user supplied Capitalisation if needed.
            if (opts.headers.hasOwnProperty('content-type') && (ctSet !== 'content-type')) {
                opts.headers[ctSet] = opts.headers['content-type'];
                delete opts.headers['content-type'];
            }
            if (opts.headers.hasOwnProperty('content-length') && (clSet !== 'content-length')) {
                opts.headers[clSet] = opts.headers['content-length'];
                delete opts.headers['content-length'];
            }
            var urltotest = url;
            var noproxy;
            if (noprox) {
                for (var i in noprox) {
                    if (url.indexOf(noprox[i]) !== -1) { noproxy=true; }
                }
            }
            if (prox && !noproxy) {
                var match = prox.match(/^(http:\/\/)?(.+)?:([0-9]+)?/i);
                if (match) {
                    //opts.protocol = "http:";
                    //opts.host = opts.hostname = match[2];
                    //opts.port = (match[3] != null ? match[3] : 80);
                    opts.headers['Host'] = opts.host;
                    var heads = opts.headers;
                    var path = opts.pathname = opts.href;
                    opts = urllib.parse(prox);
                    opts.path = opts.pathname = path;
                    opts.headers = heads;
                    opts.method = method;
                    urltotest = match[0];
                }
                else { node.warn("Bad proxy url: "+process.env.http_proxy); }
            }
            if (tlsNode) {
                tlsNode.addTLSOptions(opts);
            }
            if (req) {
                req.abort();    
            }
            req = ((/^https/.test(urltotest))?https:http).request(opts,function(res) {
                //(node.ret === "bin") ? res.setEncoding('binary') : res.setEncoding('utf8');
                msg.statusCode = res.statusCode;
                msg.headers = res.headers;
                msg.responseUrl = res.responseUrl;
                msg.payload = Buffer.from('');
                // msg.url = url;   // revert when warning above finally removed

                res.setEncoding(null);
                delete res._readableState.decoder;

                res.on('data',function(chunk) {
                    var nextPart = 0;

                    if (!boundary) {
                        var contentType = this.headers['content-type'];
                        if (contentType) {
                            // Automatically check whether multipart streaming is required
                            if (/multipart/.test(contentType)) {
                                // Automatically detect the required boundary (that will be used between parts of the stream)
                                boundary = (contentType.match(/.*;\sboundary=(.*)/) || [null, null])[1];

                                if(!boundary) {
                                    node.error(RED._("httpin.errors.no-boundary"),msg);
                                    return;
                                }

                                // A boundary needs to start with -- (even if not specified in the http header variable)
                                if (!boundary.startsWith('--')) {
                                    boundary = '--' + boundary;
                                }

                                // Every part contains of headers and a body (content) separated by two EOL (end of line) symbols.
                                // The end of line can be LF (linefeed \n), CR (carriage return \r), CRLF (carriage return linefeed \r\n).
                                // When the stream starts, the EOL should be determined.
                                var eolSymbols = (chunk.toString().match(/(?:\r\r|\n\n|\r\n\r\n)/g) || []);
                                
                                if (eolSymbols.indexOf('\r\n\r\n') >= 0) {
                                    headerBodySeparator = '\r\n\r\n';
                                }
                                else if (eolSymbols.indexOf('\r\r') >= 0) {
                                    headerBodySeparator = '\r\r';
                                }
                                else if (eolSymbols.indexOf('\n\n') >= 0) {
                                    headerBodySeparator = '\n\n';
                                }

                                if(!headerBodySeparator) {
                                    node.error(RED._("httpin.errors.no-separator"),msg);
                                    return;
                                }
                            }
                        }
                    }
                 
                    // Append the chunk to other (non-processed) chunk data
                    chunkBuffer = Buffer.concat([chunkBuffer, chunk]);
                    chunk = null;                   

                    if (boundary) {
                        while(true) {
                            // Parts are separated by boundaries, so try to isolate parts in the received chunks.
                            var bodyEnd = chunkBuffer.indexOf(boundary, nextPart);

                            if (bodyEnd == -1) {
                                // Store the remaining (incomplete) part in the chunk buffer, to be processed when the next chunk arrives
                                chunkBuffer = chunkBuffer.slice(nextPart, chunkBuffer.length);
                                break;
                            }

                            nextPart = bodyEnd + boundary.length;

                            // Find the part body (that arrives after the part header)
                            // The header 'Content length' is optional, so it cannot be used here
                            var bodyStart = chunkBuffer.indexOf(headerBodySeparator) + headerBodySeparator.length;

                            // Trim optional CR or LF characters at the start of the body
                            for (var i = bodyStart; i <= bodyEnd; i++) {
                                if (chunkBuffer[i] !== '\n' && chunkBuffer[i] !== '\r') {
                                    break;
                                }
                                bodyStart++;
                            }

                            // Trim optional CR or LF characters at the end of the body
                            for (var i = bodyEnd - 1; i >= bodyStart; i--) {
                                if (chunkBuffer[i] !== '\n' && chunkBuffer[i] !== '\r') {
                                    break;
                                }
                                bodyEnd--;
                            }

                            if (bodyEnd - bodyStart > 0) {
                                // Send the body to the output port of this node
                                msg.payload = chunkBuffer.slice(bodyStart, bodyEnd);
                                handleMsg(msg);
                            }
                        }
                    }
                });
                res.on('end',function() {
                    handleMsg(msg);
                });
            });
            req.setTimeout(node.reqTimeout, function() {
                node.error(RED._("common.notification.errors.no-response"),msg);
                setTimeout(function() {
                    node.status({fill:"red",shape:"ring",text:"common.notification.errors.no-response"});
                },10);
                req.abort();
            });
            req.on('error',function(err) {
                node.error(err,msg);
                msg.payload = err.toString() + " : " + url;
                msg.statusCode = err.code;
                node.send(msg);
                node.status({fill:"red",shape:"ring",text:err.code});
            });
            if (payload) {
                req.write(payload);
            }
            req.end();
        });

        this.on("close",function() {
            node.status({});
        });
    }

    RED.nodes.registerType("http request",HTTPRequest,{
        credentials: {
            user: {type:"text"},
            password: {type: "password"}
        }
    });
}

