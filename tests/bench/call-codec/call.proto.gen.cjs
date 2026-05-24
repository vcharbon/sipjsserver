/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-mixed-operators, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars, default-case, jsdoc/require-param*/
"use strict";

var $protobuf = require("protobufjs/minimal");

// Common aliases
var $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;

// Exported root namespace
var $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

$root.bench = (function() {

    /**
     * Namespace bench.
     * @exports bench
     * @namespace
     */
    var bench = {};

    bench.RemoteInfo = (function() {

        /**
         * Properties of a RemoteInfo.
         * @typedef {Object} bench.RemoteInfo.$Properties
         * @property {string|null} [address] RemoteInfo address
         * @property {number|null} [port] RemoteInfo port
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a RemoteInfo.
         * @memberof bench
         * @interface IRemoteInfo
         * @augments bench.RemoteInfo.$Properties
         * @deprecated Use bench.RemoteInfo.$Properties instead.
         */

        /**
         * Shape of a RemoteInfo.
         * @typedef {bench.RemoteInfo.$Properties} bench.RemoteInfo.$Shape
         */

        /**
         * Constructs a new RemoteInfo.
         * @memberof bench
         * @classdesc Represents a RemoteInfo.
         * @constructor
         * @param {bench.RemoteInfo.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function RemoteInfo(properties) {
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * RemoteInfo address.
         * @member {string} address
         * @memberof bench.RemoteInfo
         * @instance
         */
        RemoteInfo.prototype.address = "";

        /**
         * RemoteInfo port.
         * @member {number} port
         * @memberof bench.RemoteInfo
         * @instance
         */
        RemoteInfo.prototype.port = 0;

        /**
         * Creates a new RemoteInfo instance using the specified properties.
         * @function create
         * @memberof bench.RemoteInfo
         * @static
         * @param {bench.RemoteInfo.$Properties=} [properties] Properties to set
         * @returns {bench.RemoteInfo} RemoteInfo instance
         * @type {{
         *   (properties: bench.RemoteInfo.$Shape): bench.RemoteInfo & bench.RemoteInfo.$Shape;
         *   (properties?: bench.RemoteInfo.$Properties): bench.RemoteInfo;
         * }}
         */
        RemoteInfo.create = function create(properties) {
            return new RemoteInfo(properties);
        };

        /**
         * Encodes the specified RemoteInfo message. Does not implicitly {@link bench.RemoteInfo.verify|verify} messages.
         * @function encode
         * @memberof bench.RemoteInfo
         * @static
         * @param {bench.RemoteInfo.$Properties} message RemoteInfo message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        RemoteInfo.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.address != null && Object.hasOwnProperty.call(message, "address"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.address);
            if (message.port != null && Object.hasOwnProperty.call(message, "port"))
                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.port);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified RemoteInfo message, length delimited. Does not implicitly {@link bench.RemoteInfo.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.RemoteInfo
         * @static
         * @param {bench.RemoteInfo.$Properties} message RemoteInfo message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        RemoteInfo.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a RemoteInfo message from the specified reader or buffer.
         * @function decode
         * @memberof bench.RemoteInfo
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.RemoteInfo & bench.RemoteInfo.$Shape} RemoteInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        RemoteInfo.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.RemoteInfo(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.address = value;
                        else
                            delete message.address;
                        continue;
                    }
                case 2: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.int32())
                            message.port = value;
                        else
                            delete message.port;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a RemoteInfo message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.RemoteInfo
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.RemoteInfo & bench.RemoteInfo.$Shape} RemoteInfo
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        RemoteInfo.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a RemoteInfo message.
         * @function verify
         * @memberof bench.RemoteInfo
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        RemoteInfo.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.address != null && message.hasOwnProperty("address"))
                if (!$util.isString(message.address))
                    return "address: string expected";
            if (message.port != null && message.hasOwnProperty("port"))
                if (!$util.isInteger(message.port))
                    return "port: integer expected";
            return null;
        };

        /**
         * Creates a RemoteInfo message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.RemoteInfo
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.RemoteInfo} RemoteInfo
         */
        RemoteInfo.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.RemoteInfo)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.RemoteInfo();
            if (object.address != null)
                if (typeof object.address !== "string" || object.address.length)
                    message.address = String(object.address);
            if (object.port != null)
                if (Number(object.port) !== 0)
                    message.port = object.port | 0;
            return message;
        };

        /**
         * Creates a plain object from a RemoteInfo message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.RemoteInfo
         * @static
         * @param {bench.RemoteInfo} message RemoteInfo
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        RemoteInfo.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.defaults) {
                object.address = "";
                object.port = 0;
            }
            if (message.address != null && message.hasOwnProperty("address"))
                object.address = message.address;
            if (message.port != null && message.hasOwnProperty("port"))
                object.port = message.port;
            return object;
        };

        /**
         * Converts this RemoteInfo to JSON.
         * @function toJSON
         * @memberof bench.RemoteInfo
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        RemoteInfo.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for RemoteInfo
         * @function getTypeUrl
         * @memberof bench.RemoteInfo
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        RemoteInfo.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.RemoteInfo";
        };

        return RemoteInfo;
    })();

    bench.SipHeader = (function() {

        /**
         * Properties of a SipHeader.
         * @typedef {Object} bench.SipHeader.$Properties
         * @property {string|null} [name] SipHeader name
         * @property {string|null} [value] SipHeader value
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a SipHeader.
         * @memberof bench
         * @interface ISipHeader
         * @augments bench.SipHeader.$Properties
         * @deprecated Use bench.SipHeader.$Properties instead.
         */

        /**
         * Shape of a SipHeader.
         * @typedef {bench.SipHeader.$Properties} bench.SipHeader.$Shape
         */

        /**
         * Constructs a new SipHeader.
         * @memberof bench
         * @classdesc Represents a SipHeader.
         * @constructor
         * @param {bench.SipHeader.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function SipHeader(properties) {
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * SipHeader name.
         * @member {string} name
         * @memberof bench.SipHeader
         * @instance
         */
        SipHeader.prototype.name = "";

        /**
         * SipHeader value.
         * @member {string} value
         * @memberof bench.SipHeader
         * @instance
         */
        SipHeader.prototype.value = "";

        /**
         * Creates a new SipHeader instance using the specified properties.
         * @function create
         * @memberof bench.SipHeader
         * @static
         * @param {bench.SipHeader.$Properties=} [properties] Properties to set
         * @returns {bench.SipHeader} SipHeader instance
         * @type {{
         *   (properties: bench.SipHeader.$Shape): bench.SipHeader & bench.SipHeader.$Shape;
         *   (properties?: bench.SipHeader.$Properties): bench.SipHeader;
         * }}
         */
        SipHeader.create = function create(properties) {
            return new SipHeader(properties);
        };

        /**
         * Encodes the specified SipHeader message. Does not implicitly {@link bench.SipHeader.verify|verify} messages.
         * @function encode
         * @memberof bench.SipHeader
         * @static
         * @param {bench.SipHeader.$Properties} message SipHeader message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        SipHeader.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.name != null && Object.hasOwnProperty.call(message, "name"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.name);
            if (message.value != null && Object.hasOwnProperty.call(message, "value"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.value);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified SipHeader message, length delimited. Does not implicitly {@link bench.SipHeader.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.SipHeader
         * @static
         * @param {bench.SipHeader.$Properties} message SipHeader message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        SipHeader.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a SipHeader message from the specified reader or buffer.
         * @function decode
         * @memberof bench.SipHeader
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.SipHeader & bench.SipHeader.$Shape} SipHeader
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        SipHeader.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.SipHeader(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.name = value;
                        else
                            delete message.name;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.value = value;
                        else
                            delete message.value;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a SipHeader message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.SipHeader
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.SipHeader & bench.SipHeader.$Shape} SipHeader
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        SipHeader.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a SipHeader message.
         * @function verify
         * @memberof bench.SipHeader
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        SipHeader.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.name != null && message.hasOwnProperty("name"))
                if (!$util.isString(message.name))
                    return "name: string expected";
            if (message.value != null && message.hasOwnProperty("value"))
                if (!$util.isString(message.value))
                    return "value: string expected";
            return null;
        };

        /**
         * Creates a SipHeader message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.SipHeader
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.SipHeader} SipHeader
         */
        SipHeader.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.SipHeader)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.SipHeader();
            if (object.name != null)
                if (typeof object.name !== "string" || object.name.length)
                    message.name = String(object.name);
            if (object.value != null)
                if (typeof object.value !== "string" || object.value.length)
                    message.value = String(object.value);
            return message;
        };

        /**
         * Creates a plain object from a SipHeader message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.SipHeader
         * @static
         * @param {bench.SipHeader} message SipHeader
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        SipHeader.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.defaults) {
                object.name = "";
                object.value = "";
            }
            if (message.name != null && message.hasOwnProperty("name"))
                object.name = message.name;
            if (message.value != null && message.hasOwnProperty("value"))
                object.value = message.value;
            return object;
        };

        /**
         * Converts this SipHeader to JSON.
         * @function toJSON
         * @memberof bench.SipHeader
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        SipHeader.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for SipHeader
         * @function getTypeUrl
         * @memberof bench.SipHeader
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        SipHeader.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.SipHeader";
        };

        return SipHeader;
    })();

    bench.PendingRequest = (function() {

        /**
         * Properties of a PendingRequest.
         * @typedef {Object} bench.PendingRequest.$Properties
         * @property {string|null} [method] PendingRequest method
         * @property {number|null} [outboundCSeq] PendingRequest outboundCSeq
         * @property {number|null} [inboundCSeq] PendingRequest inboundCSeq
         * @property {Array.<string>|null} [sourceVias] PendingRequest sourceVias
         * @property {string|null} [sourceCallId] PendingRequest sourceCallId
         * @property {string|null} [sourceFrom] PendingRequest sourceFrom
         * @property {string|null} [sourceTo] PendingRequest sourceTo
         * @property {string|null} [direction] PendingRequest direction
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a PendingRequest.
         * @memberof bench
         * @interface IPendingRequest
         * @augments bench.PendingRequest.$Properties
         * @deprecated Use bench.PendingRequest.$Properties instead.
         */

        /**
         * Shape of a PendingRequest.
         * @typedef {bench.PendingRequest.$Properties} bench.PendingRequest.$Shape
         */

        /**
         * Constructs a new PendingRequest.
         * @memberof bench
         * @classdesc Represents a PendingRequest.
         * @constructor
         * @param {bench.PendingRequest.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function PendingRequest(properties) {
            this.sourceVias = [];
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * PendingRequest method.
         * @member {string} method
         * @memberof bench.PendingRequest
         * @instance
         */
        PendingRequest.prototype.method = "";

        /**
         * PendingRequest outboundCSeq.
         * @member {number} outboundCSeq
         * @memberof bench.PendingRequest
         * @instance
         */
        PendingRequest.prototype.outboundCSeq = 0;

        /**
         * PendingRequest inboundCSeq.
         * @member {number} inboundCSeq
         * @memberof bench.PendingRequest
         * @instance
         */
        PendingRequest.prototype.inboundCSeq = 0;

        /**
         * PendingRequest sourceVias.
         * @member {Array.<string>} sourceVias
         * @memberof bench.PendingRequest
         * @instance
         */
        PendingRequest.prototype.sourceVias = $util.emptyArray;

        /**
         * PendingRequest sourceCallId.
         * @member {string} sourceCallId
         * @memberof bench.PendingRequest
         * @instance
         */
        PendingRequest.prototype.sourceCallId = "";

        /**
         * PendingRequest sourceFrom.
         * @member {string} sourceFrom
         * @memberof bench.PendingRequest
         * @instance
         */
        PendingRequest.prototype.sourceFrom = "";

        /**
         * PendingRequest sourceTo.
         * @member {string} sourceTo
         * @memberof bench.PendingRequest
         * @instance
         */
        PendingRequest.prototype.sourceTo = "";

        /**
         * PendingRequest direction.
         * @member {string} direction
         * @memberof bench.PendingRequest
         * @instance
         */
        PendingRequest.prototype.direction = "";

        /**
         * Creates a new PendingRequest instance using the specified properties.
         * @function create
         * @memberof bench.PendingRequest
         * @static
         * @param {bench.PendingRequest.$Properties=} [properties] Properties to set
         * @returns {bench.PendingRequest} PendingRequest instance
         * @type {{
         *   (properties: bench.PendingRequest.$Shape): bench.PendingRequest & bench.PendingRequest.$Shape;
         *   (properties?: bench.PendingRequest.$Properties): bench.PendingRequest;
         * }}
         */
        PendingRequest.create = function create(properties) {
            return new PendingRequest(properties);
        };

        /**
         * Encodes the specified PendingRequest message. Does not implicitly {@link bench.PendingRequest.verify|verify} messages.
         * @function encode
         * @memberof bench.PendingRequest
         * @static
         * @param {bench.PendingRequest.$Properties} message PendingRequest message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PendingRequest.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.method != null && Object.hasOwnProperty.call(message, "method"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.method);
            if (message.outboundCSeq != null && Object.hasOwnProperty.call(message, "outboundCSeq"))
                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.outboundCSeq);
            if (message.inboundCSeq != null && Object.hasOwnProperty.call(message, "inboundCSeq"))
                writer.uint32(/* id 3, wireType 0 =*/24).int32(message.inboundCSeq);
            if (message.sourceVias != null && message.sourceVias.length)
                for (var i = 0; i < message.sourceVias.length; ++i)
                    writer.uint32(/* id 4, wireType 2 =*/34).string(message.sourceVias[i]);
            if (message.sourceCallId != null && Object.hasOwnProperty.call(message, "sourceCallId"))
                writer.uint32(/* id 5, wireType 2 =*/42).string(message.sourceCallId);
            if (message.sourceFrom != null && Object.hasOwnProperty.call(message, "sourceFrom"))
                writer.uint32(/* id 6, wireType 2 =*/50).string(message.sourceFrom);
            if (message.sourceTo != null && Object.hasOwnProperty.call(message, "sourceTo"))
                writer.uint32(/* id 7, wireType 2 =*/58).string(message.sourceTo);
            if (message.direction != null && Object.hasOwnProperty.call(message, "direction"))
                writer.uint32(/* id 8, wireType 2 =*/66).string(message.direction);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified PendingRequest message, length delimited. Does not implicitly {@link bench.PendingRequest.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.PendingRequest
         * @static
         * @param {bench.PendingRequest.$Properties} message PendingRequest message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        PendingRequest.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a PendingRequest message from the specified reader or buffer.
         * @function decode
         * @memberof bench.PendingRequest
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.PendingRequest & bench.PendingRequest.$Shape} PendingRequest
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PendingRequest.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.PendingRequest(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.method = value;
                        else
                            delete message.method;
                        continue;
                    }
                case 2: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.int32())
                            message.outboundCSeq = value;
                        else
                            delete message.outboundCSeq;
                        continue;
                    }
                case 3: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.int32())
                            message.inboundCSeq = value;
                        else
                            delete message.inboundCSeq;
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        if (!(message.sourceVias && message.sourceVias.length))
                            message.sourceVias = [];
                        message.sourceVias.push(reader.string());
                        continue;
                    }
                case 5: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.sourceCallId = value;
                        else
                            delete message.sourceCallId;
                        continue;
                    }
                case 6: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.sourceFrom = value;
                        else
                            delete message.sourceFrom;
                        continue;
                    }
                case 7: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.sourceTo = value;
                        else
                            delete message.sourceTo;
                        continue;
                    }
                case 8: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.direction = value;
                        else
                            delete message.direction;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a PendingRequest message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.PendingRequest
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.PendingRequest & bench.PendingRequest.$Shape} PendingRequest
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        PendingRequest.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a PendingRequest message.
         * @function verify
         * @memberof bench.PendingRequest
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        PendingRequest.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.method != null && message.hasOwnProperty("method"))
                if (!$util.isString(message.method))
                    return "method: string expected";
            if (message.outboundCSeq != null && message.hasOwnProperty("outboundCSeq"))
                if (!$util.isInteger(message.outboundCSeq))
                    return "outboundCSeq: integer expected";
            if (message.inboundCSeq != null && message.hasOwnProperty("inboundCSeq"))
                if (!$util.isInteger(message.inboundCSeq))
                    return "inboundCSeq: integer expected";
            if (message.sourceVias != null && message.hasOwnProperty("sourceVias")) {
                if (!Array.isArray(message.sourceVias))
                    return "sourceVias: array expected";
                for (var i = 0; i < message.sourceVias.length; ++i)
                    if (!$util.isString(message.sourceVias[i]))
                        return "sourceVias: string[] expected";
            }
            if (message.sourceCallId != null && message.hasOwnProperty("sourceCallId"))
                if (!$util.isString(message.sourceCallId))
                    return "sourceCallId: string expected";
            if (message.sourceFrom != null && message.hasOwnProperty("sourceFrom"))
                if (!$util.isString(message.sourceFrom))
                    return "sourceFrom: string expected";
            if (message.sourceTo != null && message.hasOwnProperty("sourceTo"))
                if (!$util.isString(message.sourceTo))
                    return "sourceTo: string expected";
            if (message.direction != null && message.hasOwnProperty("direction"))
                if (!$util.isString(message.direction))
                    return "direction: string expected";
            return null;
        };

        /**
         * Creates a PendingRequest message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.PendingRequest
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.PendingRequest} PendingRequest
         */
        PendingRequest.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.PendingRequest)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.PendingRequest();
            if (object.method != null)
                if (typeof object.method !== "string" || object.method.length)
                    message.method = String(object.method);
            if (object.outboundCSeq != null)
                if (Number(object.outboundCSeq) !== 0)
                    message.outboundCSeq = object.outboundCSeq | 0;
            if (object.inboundCSeq != null)
                if (Number(object.inboundCSeq) !== 0)
                    message.inboundCSeq = object.inboundCSeq | 0;
            if (object.sourceVias) {
                if (!Array.isArray(object.sourceVias))
                    throw TypeError(".bench.PendingRequest.sourceVias: array expected");
                message.sourceVias = Array(object.sourceVias.length);
                for (var i = 0; i < object.sourceVias.length; ++i)
                    message.sourceVias[i] = String(object.sourceVias[i]);
            }
            if (object.sourceCallId != null)
                if (typeof object.sourceCallId !== "string" || object.sourceCallId.length)
                    message.sourceCallId = String(object.sourceCallId);
            if (object.sourceFrom != null)
                if (typeof object.sourceFrom !== "string" || object.sourceFrom.length)
                    message.sourceFrom = String(object.sourceFrom);
            if (object.sourceTo != null)
                if (typeof object.sourceTo !== "string" || object.sourceTo.length)
                    message.sourceTo = String(object.sourceTo);
            if (object.direction != null)
                if (typeof object.direction !== "string" || object.direction.length)
                    message.direction = String(object.direction);
            return message;
        };

        /**
         * Creates a plain object from a PendingRequest message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.PendingRequest
         * @static
         * @param {bench.PendingRequest} message PendingRequest
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        PendingRequest.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.arrays || options.defaults)
                object.sourceVias = [];
            if (options.defaults) {
                object.method = "";
                object.outboundCSeq = 0;
                object.inboundCSeq = 0;
                object.sourceCallId = "";
                object.sourceFrom = "";
                object.sourceTo = "";
                object.direction = "";
            }
            if (message.method != null && message.hasOwnProperty("method"))
                object.method = message.method;
            if (message.outboundCSeq != null && message.hasOwnProperty("outboundCSeq"))
                object.outboundCSeq = message.outboundCSeq;
            if (message.inboundCSeq != null && message.hasOwnProperty("inboundCSeq"))
                object.inboundCSeq = message.inboundCSeq;
            if (message.sourceVias && message.sourceVias.length) {
                object.sourceVias = Array(message.sourceVias.length);
                for (var j = 0; j < message.sourceVias.length; ++j)
                    object.sourceVias[j] = message.sourceVias[j];
            }
            if (message.sourceCallId != null && message.hasOwnProperty("sourceCallId"))
                object.sourceCallId = message.sourceCallId;
            if (message.sourceFrom != null && message.hasOwnProperty("sourceFrom"))
                object.sourceFrom = message.sourceFrom;
            if (message.sourceTo != null && message.hasOwnProperty("sourceTo"))
                object.sourceTo = message.sourceTo;
            if (message.direction != null && message.hasOwnProperty("direction"))
                object.direction = message.direction;
            return object;
        };

        /**
         * Converts this PendingRequest to JSON.
         * @function toJSON
         * @memberof bench.PendingRequest
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        PendingRequest.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for PendingRequest
         * @function getTypeUrl
         * @memberof bench.PendingRequest
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        PendingRequest.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.PendingRequest";
        };

        return PendingRequest;
    })();

    bench.StackDialog = (function() {

        /**
         * Properties of a StackDialog.
         * @typedef {Object} bench.StackDialog.$Properties
         * @property {string|null} [callId] StackDialog callId
         * @property {string|null} [localTag] StackDialog localTag
         * @property {string|null} [remoteTag] StackDialog remoteTag
         * @property {string|null} [localUri] StackDialog localUri
         * @property {string|null} [remoteUri] StackDialog remoteUri
         * @property {string|null} [remoteTarget] StackDialog remoteTarget
         * @property {number|null} [localCSeq] StackDialog localCSeq
         * @property {Array.<string>|null} [routeSet] StackDialog routeSet
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a StackDialog.
         * @memberof bench
         * @interface IStackDialog
         * @augments bench.StackDialog.$Properties
         * @deprecated Use bench.StackDialog.$Properties instead.
         */

        /**
         * Shape of a StackDialog.
         * @typedef {bench.StackDialog.$Properties} bench.StackDialog.$Shape
         */

        /**
         * Constructs a new StackDialog.
         * @memberof bench
         * @classdesc Represents a StackDialog.
         * @constructor
         * @param {bench.StackDialog.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function StackDialog(properties) {
            this.routeSet = [];
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * StackDialog callId.
         * @member {string} callId
         * @memberof bench.StackDialog
         * @instance
         */
        StackDialog.prototype.callId = "";

        /**
         * StackDialog localTag.
         * @member {string} localTag
         * @memberof bench.StackDialog
         * @instance
         */
        StackDialog.prototype.localTag = "";

        /**
         * StackDialog remoteTag.
         * @member {string} remoteTag
         * @memberof bench.StackDialog
         * @instance
         */
        StackDialog.prototype.remoteTag = "";

        /**
         * StackDialog localUri.
         * @member {string} localUri
         * @memberof bench.StackDialog
         * @instance
         */
        StackDialog.prototype.localUri = "";

        /**
         * StackDialog remoteUri.
         * @member {string} remoteUri
         * @memberof bench.StackDialog
         * @instance
         */
        StackDialog.prototype.remoteUri = "";

        /**
         * StackDialog remoteTarget.
         * @member {string} remoteTarget
         * @memberof bench.StackDialog
         * @instance
         */
        StackDialog.prototype.remoteTarget = "";

        /**
         * StackDialog localCSeq.
         * @member {number} localCSeq
         * @memberof bench.StackDialog
         * @instance
         */
        StackDialog.prototype.localCSeq = 0;

        /**
         * StackDialog routeSet.
         * @member {Array.<string>} routeSet
         * @memberof bench.StackDialog
         * @instance
         */
        StackDialog.prototype.routeSet = $util.emptyArray;

        /**
         * Creates a new StackDialog instance using the specified properties.
         * @function create
         * @memberof bench.StackDialog
         * @static
         * @param {bench.StackDialog.$Properties=} [properties] Properties to set
         * @returns {bench.StackDialog} StackDialog instance
         * @type {{
         *   (properties: bench.StackDialog.$Shape): bench.StackDialog & bench.StackDialog.$Shape;
         *   (properties?: bench.StackDialog.$Properties): bench.StackDialog;
         * }}
         */
        StackDialog.create = function create(properties) {
            return new StackDialog(properties);
        };

        /**
         * Encodes the specified StackDialog message. Does not implicitly {@link bench.StackDialog.verify|verify} messages.
         * @function encode
         * @memberof bench.StackDialog
         * @static
         * @param {bench.StackDialog.$Properties} message StackDialog message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        StackDialog.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.callId != null && Object.hasOwnProperty.call(message, "callId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.callId);
            if (message.localTag != null && Object.hasOwnProperty.call(message, "localTag"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.localTag);
            if (message.remoteTag != null && Object.hasOwnProperty.call(message, "remoteTag"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.remoteTag);
            if (message.localUri != null && Object.hasOwnProperty.call(message, "localUri"))
                writer.uint32(/* id 4, wireType 2 =*/34).string(message.localUri);
            if (message.remoteUri != null && Object.hasOwnProperty.call(message, "remoteUri"))
                writer.uint32(/* id 5, wireType 2 =*/42).string(message.remoteUri);
            if (message.remoteTarget != null && Object.hasOwnProperty.call(message, "remoteTarget"))
                writer.uint32(/* id 6, wireType 2 =*/50).string(message.remoteTarget);
            if (message.localCSeq != null && Object.hasOwnProperty.call(message, "localCSeq"))
                writer.uint32(/* id 7, wireType 0 =*/56).int32(message.localCSeq);
            if (message.routeSet != null && message.routeSet.length)
                for (var i = 0; i < message.routeSet.length; ++i)
                    writer.uint32(/* id 8, wireType 2 =*/66).string(message.routeSet[i]);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified StackDialog message, length delimited. Does not implicitly {@link bench.StackDialog.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.StackDialog
         * @static
         * @param {bench.StackDialog.$Properties} message StackDialog message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        StackDialog.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a StackDialog message from the specified reader or buffer.
         * @function decode
         * @memberof bench.StackDialog
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.StackDialog & bench.StackDialog.$Shape} StackDialog
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        StackDialog.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.StackDialog(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.callId = value;
                        else
                            delete message.callId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.localTag = value;
                        else
                            delete message.localTag;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.remoteTag = value;
                        else
                            delete message.remoteTag;
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.localUri = value;
                        else
                            delete message.localUri;
                        continue;
                    }
                case 5: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.remoteUri = value;
                        else
                            delete message.remoteUri;
                        continue;
                    }
                case 6: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.remoteTarget = value;
                        else
                            delete message.remoteTarget;
                        continue;
                    }
                case 7: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.int32())
                            message.localCSeq = value;
                        else
                            delete message.localCSeq;
                        continue;
                    }
                case 8: {
                        if (wireType !== 2)
                            break;
                        if (!(message.routeSet && message.routeSet.length))
                            message.routeSet = [];
                        message.routeSet.push(reader.string());
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a StackDialog message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.StackDialog
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.StackDialog & bench.StackDialog.$Shape} StackDialog
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        StackDialog.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a StackDialog message.
         * @function verify
         * @memberof bench.StackDialog
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        StackDialog.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.callId != null && message.hasOwnProperty("callId"))
                if (!$util.isString(message.callId))
                    return "callId: string expected";
            if (message.localTag != null && message.hasOwnProperty("localTag"))
                if (!$util.isString(message.localTag))
                    return "localTag: string expected";
            if (message.remoteTag != null && message.hasOwnProperty("remoteTag"))
                if (!$util.isString(message.remoteTag))
                    return "remoteTag: string expected";
            if (message.localUri != null && message.hasOwnProperty("localUri"))
                if (!$util.isString(message.localUri))
                    return "localUri: string expected";
            if (message.remoteUri != null && message.hasOwnProperty("remoteUri"))
                if (!$util.isString(message.remoteUri))
                    return "remoteUri: string expected";
            if (message.remoteTarget != null && message.hasOwnProperty("remoteTarget"))
                if (!$util.isString(message.remoteTarget))
                    return "remoteTarget: string expected";
            if (message.localCSeq != null && message.hasOwnProperty("localCSeq"))
                if (!$util.isInteger(message.localCSeq))
                    return "localCSeq: integer expected";
            if (message.routeSet != null && message.hasOwnProperty("routeSet")) {
                if (!Array.isArray(message.routeSet))
                    return "routeSet: array expected";
                for (var i = 0; i < message.routeSet.length; ++i)
                    if (!$util.isString(message.routeSet[i]))
                        return "routeSet: string[] expected";
            }
            return null;
        };

        /**
         * Creates a StackDialog message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.StackDialog
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.StackDialog} StackDialog
         */
        StackDialog.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.StackDialog)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.StackDialog();
            if (object.callId != null)
                if (typeof object.callId !== "string" || object.callId.length)
                    message.callId = String(object.callId);
            if (object.localTag != null)
                if (typeof object.localTag !== "string" || object.localTag.length)
                    message.localTag = String(object.localTag);
            if (object.remoteTag != null)
                if (typeof object.remoteTag !== "string" || object.remoteTag.length)
                    message.remoteTag = String(object.remoteTag);
            if (object.localUri != null)
                if (typeof object.localUri !== "string" || object.localUri.length)
                    message.localUri = String(object.localUri);
            if (object.remoteUri != null)
                if (typeof object.remoteUri !== "string" || object.remoteUri.length)
                    message.remoteUri = String(object.remoteUri);
            if (object.remoteTarget != null)
                if (typeof object.remoteTarget !== "string" || object.remoteTarget.length)
                    message.remoteTarget = String(object.remoteTarget);
            if (object.localCSeq != null)
                if (Number(object.localCSeq) !== 0)
                    message.localCSeq = object.localCSeq | 0;
            if (object.routeSet) {
                if (!Array.isArray(object.routeSet))
                    throw TypeError(".bench.StackDialog.routeSet: array expected");
                message.routeSet = Array(object.routeSet.length);
                for (var i = 0; i < object.routeSet.length; ++i)
                    message.routeSet[i] = String(object.routeSet[i]);
            }
            return message;
        };

        /**
         * Creates a plain object from a StackDialog message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.StackDialog
         * @static
         * @param {bench.StackDialog} message StackDialog
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        StackDialog.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.arrays || options.defaults)
                object.routeSet = [];
            if (options.defaults) {
                object.callId = "";
                object.localTag = "";
                object.remoteTag = "";
                object.localUri = "";
                object.remoteUri = "";
                object.remoteTarget = "";
                object.localCSeq = 0;
            }
            if (message.callId != null && message.hasOwnProperty("callId"))
                object.callId = message.callId;
            if (message.localTag != null && message.hasOwnProperty("localTag"))
                object.localTag = message.localTag;
            if (message.remoteTag != null && message.hasOwnProperty("remoteTag"))
                object.remoteTag = message.remoteTag;
            if (message.localUri != null && message.hasOwnProperty("localUri"))
                object.localUri = message.localUri;
            if (message.remoteUri != null && message.hasOwnProperty("remoteUri"))
                object.remoteUri = message.remoteUri;
            if (message.remoteTarget != null && message.hasOwnProperty("remoteTarget"))
                object.remoteTarget = message.remoteTarget;
            if (message.localCSeq != null && message.hasOwnProperty("localCSeq"))
                object.localCSeq = message.localCSeq;
            if (message.routeSet && message.routeSet.length) {
                object.routeSet = Array(message.routeSet.length);
                for (var j = 0; j < message.routeSet.length; ++j)
                    object.routeSet[j] = message.routeSet[j];
            }
            return object;
        };

        /**
         * Converts this StackDialog to JSON.
         * @function toJSON
         * @memberof bench.StackDialog
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        StackDialog.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for StackDialog
         * @function getTypeUrl
         * @memberof bench.StackDialog
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        StackDialog.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.StackDialog";
        };

        return StackDialog;
    })();

    bench.B2buaDialogExt = (function() {

        /**
         * Properties of a B2buaDialogExt.
         * @typedef {Object} bench.B2buaDialogExt.$Properties
         * @property {number|null} [remoteCSeq] B2buaDialogExt remoteCSeq
         * @property {Array.<bench.PendingRequest.$Properties>|null} [inboundPendingRequests] B2buaDialogExt inboundPendingRequests
         * @property {string|null} [ackBranch] B2buaDialogExt ackBranch
         * @property {Uint8Array|null} [cachedSdp] B2buaDialogExt cachedSdp
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a B2buaDialogExt.
         * @memberof bench
         * @interface IB2buaDialogExt
         * @augments bench.B2buaDialogExt.$Properties
         * @deprecated Use bench.B2buaDialogExt.$Properties instead.
         */

        /**
         * Shape of a B2buaDialogExt.
         * @typedef {bench.B2buaDialogExt.$Properties} bench.B2buaDialogExt.$Shape
         */

        /**
         * Constructs a new B2buaDialogExt.
         * @memberof bench
         * @classdesc Represents a B2buaDialogExt.
         * @constructor
         * @param {bench.B2buaDialogExt.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function B2buaDialogExt(properties) {
            this.inboundPendingRequests = [];
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * B2buaDialogExt remoteCSeq.
         * @member {number|null|undefined} remoteCSeq
         * @memberof bench.B2buaDialogExt
         * @instance
         */
        B2buaDialogExt.prototype.remoteCSeq = null;

        /**
         * B2buaDialogExt inboundPendingRequests.
         * @member {Array.<bench.PendingRequest.$Properties>} inboundPendingRequests
         * @memberof bench.B2buaDialogExt
         * @instance
         */
        B2buaDialogExt.prototype.inboundPendingRequests = $util.emptyArray;

        /**
         * B2buaDialogExt ackBranch.
         * @member {string|null|undefined} ackBranch
         * @memberof bench.B2buaDialogExt
         * @instance
         */
        B2buaDialogExt.prototype.ackBranch = null;

        /**
         * B2buaDialogExt cachedSdp.
         * @member {Uint8Array|null|undefined} cachedSdp
         * @memberof bench.B2buaDialogExt
         * @instance
         */
        B2buaDialogExt.prototype.cachedSdp = null;

        // OneOf field names bound to virtual getters and setters
        var $oneOfFields;

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(B2buaDialogExt.prototype, "_remoteCSeq", {
            get: $util.oneOfGetter($oneOfFields = ["remoteCSeq"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(B2buaDialogExt.prototype, "_ackBranch", {
            get: $util.oneOfGetter($oneOfFields = ["ackBranch"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(B2buaDialogExt.prototype, "_cachedSdp", {
            get: $util.oneOfGetter($oneOfFields = ["cachedSdp"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new B2buaDialogExt instance using the specified properties.
         * @function create
         * @memberof bench.B2buaDialogExt
         * @static
         * @param {bench.B2buaDialogExt.$Properties=} [properties] Properties to set
         * @returns {bench.B2buaDialogExt} B2buaDialogExt instance
         * @type {{
         *   (properties: bench.B2buaDialogExt.$Shape): bench.B2buaDialogExt & bench.B2buaDialogExt.$Shape;
         *   (properties?: bench.B2buaDialogExt.$Properties): bench.B2buaDialogExt;
         * }}
         */
        B2buaDialogExt.create = function create(properties) {
            return new B2buaDialogExt(properties);
        };

        /**
         * Encodes the specified B2buaDialogExt message. Does not implicitly {@link bench.B2buaDialogExt.verify|verify} messages.
         * @function encode
         * @memberof bench.B2buaDialogExt
         * @static
         * @param {bench.B2buaDialogExt.$Properties} message B2buaDialogExt message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        B2buaDialogExt.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.remoteCSeq != null && Object.hasOwnProperty.call(message, "remoteCSeq"))
                writer.uint32(/* id 1, wireType 0 =*/8).int32(message.remoteCSeq);
            if (message.inboundPendingRequests != null && message.inboundPendingRequests.length)
                for (var i = 0; i < message.inboundPendingRequests.length; ++i)
                    $root.bench.PendingRequest.encode(message.inboundPendingRequests[i], writer.uint32(/* id 2, wireType 2 =*/18).fork(), _depth + 1).ldelim();
            if (message.ackBranch != null && Object.hasOwnProperty.call(message, "ackBranch"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.ackBranch);
            if (message.cachedSdp != null && Object.hasOwnProperty.call(message, "cachedSdp"))
                writer.uint32(/* id 5, wireType 2 =*/42).bytes(message.cachedSdp);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified B2buaDialogExt message, length delimited. Does not implicitly {@link bench.B2buaDialogExt.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.B2buaDialogExt
         * @static
         * @param {bench.B2buaDialogExt.$Properties} message B2buaDialogExt message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        B2buaDialogExt.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a B2buaDialogExt message from the specified reader or buffer.
         * @function decode
         * @memberof bench.B2buaDialogExt
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.B2buaDialogExt & bench.B2buaDialogExt.$Shape} B2buaDialogExt
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        B2buaDialogExt.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.B2buaDialogExt();
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 0)
                            break;
                        message.remoteCSeq = reader.int32();
                        message._remoteCSeq = "remoteCSeq";
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if (!(message.inboundPendingRequests && message.inboundPendingRequests.length))
                            message.inboundPendingRequests = [];
                        message.inboundPendingRequests.push($root.bench.PendingRequest.decode(reader, reader.uint32(), undefined, _depth + 1));
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        message.ackBranch = reader.string();
                        message._ackBranch = "ackBranch";
                        continue;
                    }
                case 5: {
                        if (wireType !== 2)
                            break;
                        message.cachedSdp = reader.bytes();
                        message._cachedSdp = "cachedSdp";
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a B2buaDialogExt message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.B2buaDialogExt
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.B2buaDialogExt & bench.B2buaDialogExt.$Shape} B2buaDialogExt
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        B2buaDialogExt.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a B2buaDialogExt message.
         * @function verify
         * @memberof bench.B2buaDialogExt
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        B2buaDialogExt.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            var properties = {};
            if (message.remoteCSeq != null && message.hasOwnProperty("remoteCSeq")) {
                properties._remoteCSeq = 1;
                if (!$util.isInteger(message.remoteCSeq))
                    return "remoteCSeq: integer expected";
            }
            if (message.inboundPendingRequests != null && message.hasOwnProperty("inboundPendingRequests")) {
                if (!Array.isArray(message.inboundPendingRequests))
                    return "inboundPendingRequests: array expected";
                for (var i = 0; i < message.inboundPendingRequests.length; ++i) {
                    var error = $root.bench.PendingRequest.verify(message.inboundPendingRequests[i], _depth + 1);
                    if (error)
                        return "inboundPendingRequests." + error;
                }
            }
            if (message.ackBranch != null && message.hasOwnProperty("ackBranch")) {
                properties._ackBranch = 1;
                if (!$util.isString(message.ackBranch))
                    return "ackBranch: string expected";
            }
            if (message.cachedSdp != null && message.hasOwnProperty("cachedSdp")) {
                properties._cachedSdp = 1;
                if (!(message.cachedSdp && typeof message.cachedSdp.length === "number" || $util.isString(message.cachedSdp)))
                    return "cachedSdp: buffer expected";
            }
            return null;
        };

        /**
         * Creates a B2buaDialogExt message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.B2buaDialogExt
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.B2buaDialogExt} B2buaDialogExt
         */
        B2buaDialogExt.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.B2buaDialogExt)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.B2buaDialogExt();
            if (object.remoteCSeq != null)
                message.remoteCSeq = object.remoteCSeq | 0;
            if (object.inboundPendingRequests) {
                if (!Array.isArray(object.inboundPendingRequests))
                    throw TypeError(".bench.B2buaDialogExt.inboundPendingRequests: array expected");
                message.inboundPendingRequests = Array(object.inboundPendingRequests.length);
                for (var i = 0; i < object.inboundPendingRequests.length; ++i) {
                    if (typeof object.inboundPendingRequests[i] !== "object")
                        throw TypeError(".bench.B2buaDialogExt.inboundPendingRequests: object expected");
                    message.inboundPendingRequests[i] = $root.bench.PendingRequest.fromObject(object.inboundPendingRequests[i], _depth + 1);
                }
            }
            if (object.ackBranch != null)
                message.ackBranch = String(object.ackBranch);
            if (object.cachedSdp != null)
                if (typeof object.cachedSdp === "string")
                    $util.base64.decode(object.cachedSdp, message.cachedSdp = $util.newBuffer($util.base64.length(object.cachedSdp)), 0);
                else if (object.cachedSdp.length >= 0)
                    message.cachedSdp = object.cachedSdp;
            return message;
        };

        /**
         * Creates a plain object from a B2buaDialogExt message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.B2buaDialogExt
         * @static
         * @param {bench.B2buaDialogExt} message B2buaDialogExt
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        B2buaDialogExt.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.arrays || options.defaults)
                object.inboundPendingRequests = [];
            if (message.remoteCSeq != null && message.hasOwnProperty("remoteCSeq"))
                object.remoteCSeq = message.remoteCSeq;
            if (message.inboundPendingRequests && message.inboundPendingRequests.length) {
                object.inboundPendingRequests = Array(message.inboundPendingRequests.length);
                for (var j = 0; j < message.inboundPendingRequests.length; ++j)
                    object.inboundPendingRequests[j] = $root.bench.PendingRequest.toObject(message.inboundPendingRequests[j], options, _depth + 1);
            }
            if (message.ackBranch != null && message.hasOwnProperty("ackBranch"))
                object.ackBranch = message.ackBranch;
            if (message.cachedSdp != null && message.hasOwnProperty("cachedSdp"))
                object.cachedSdp = options.bytes === String ? $util.base64.encode(message.cachedSdp, 0, message.cachedSdp.length) : options.bytes === Array ? Array.prototype.slice.call(message.cachedSdp) : message.cachedSdp;
            return object;
        };

        /**
         * Converts this B2buaDialogExt to JSON.
         * @function toJSON
         * @memberof bench.B2buaDialogExt
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        B2buaDialogExt.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for B2buaDialogExt
         * @function getTypeUrl
         * @memberof bench.B2buaDialogExt
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        B2buaDialogExt.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.B2buaDialogExt";
        };

        return B2buaDialogExt;
    })();

    bench.Dialog = (function() {

        /**
         * Properties of a Dialog.
         * @typedef {Object} bench.Dialog.$Properties
         * @property {bench.StackDialog.$Properties|null} [sip] Dialog sip
         * @property {bench.B2buaDialogExt.$Properties|null} [ext] Dialog ext
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a Dialog.
         * @memberof bench
         * @interface IDialog
         * @augments bench.Dialog.$Properties
         * @deprecated Use bench.Dialog.$Properties instead.
         */

        /**
         * Shape of a Dialog.
         * @typedef {bench.Dialog.$Properties} bench.Dialog.$Shape
         */

        /**
         * Constructs a new Dialog.
         * @memberof bench
         * @classdesc Represents a Dialog.
         * @constructor
         * @param {bench.Dialog.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function Dialog(properties) {
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * Dialog sip.
         * @member {bench.StackDialog.$Properties|null|undefined} sip
         * @memberof bench.Dialog
         * @instance
         */
        Dialog.prototype.sip = null;

        /**
         * Dialog ext.
         * @member {bench.B2buaDialogExt.$Properties|null|undefined} ext
         * @memberof bench.Dialog
         * @instance
         */
        Dialog.prototype.ext = null;

        /**
         * Creates a new Dialog instance using the specified properties.
         * @function create
         * @memberof bench.Dialog
         * @static
         * @param {bench.Dialog.$Properties=} [properties] Properties to set
         * @returns {bench.Dialog} Dialog instance
         * @type {{
         *   (properties: bench.Dialog.$Shape): bench.Dialog & bench.Dialog.$Shape;
         *   (properties?: bench.Dialog.$Properties): bench.Dialog;
         * }}
         */
        Dialog.create = function create(properties) {
            return new Dialog(properties);
        };

        /**
         * Encodes the specified Dialog message. Does not implicitly {@link bench.Dialog.verify|verify} messages.
         * @function encode
         * @memberof bench.Dialog
         * @static
         * @param {bench.Dialog.$Properties} message Dialog message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Dialog.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.sip != null && Object.hasOwnProperty.call(message, "sip"))
                $root.bench.StackDialog.encode(message.sip, writer.uint32(/* id 1, wireType 2 =*/10).fork(), _depth + 1).ldelim();
            if (message.ext != null && Object.hasOwnProperty.call(message, "ext"))
                $root.bench.B2buaDialogExt.encode(message.ext, writer.uint32(/* id 2, wireType 2 =*/18).fork(), _depth + 1).ldelim();
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified Dialog message, length delimited. Does not implicitly {@link bench.Dialog.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.Dialog
         * @static
         * @param {bench.Dialog.$Properties} message Dialog message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Dialog.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a Dialog message from the specified reader or buffer.
         * @function decode
         * @memberof bench.Dialog
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.Dialog & bench.Dialog.$Shape} Dialog
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Dialog.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.Dialog(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        message.sip = $root.bench.StackDialog.decode(reader, reader.uint32(), undefined, _depth + 1, message.sip);
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        message.ext = $root.bench.B2buaDialogExt.decode(reader, reader.uint32(), undefined, _depth + 1, message.ext);
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a Dialog message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.Dialog
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.Dialog & bench.Dialog.$Shape} Dialog
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Dialog.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Dialog message.
         * @function verify
         * @memberof bench.Dialog
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Dialog.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.sip != null && message.hasOwnProperty("sip")) {
                var error = $root.bench.StackDialog.verify(message.sip, _depth + 1);
                if (error)
                    return "sip." + error;
            }
            if (message.ext != null && message.hasOwnProperty("ext")) {
                var error = $root.bench.B2buaDialogExt.verify(message.ext, _depth + 1);
                if (error)
                    return "ext." + error;
            }
            return null;
        };

        /**
         * Creates a Dialog message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.Dialog
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.Dialog} Dialog
         */
        Dialog.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.Dialog)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.Dialog();
            if (object.sip != null) {
                if (typeof object.sip !== "object")
                    throw TypeError(".bench.Dialog.sip: object expected");
                message.sip = $root.bench.StackDialog.fromObject(object.sip, _depth + 1);
            }
            if (object.ext != null) {
                if (typeof object.ext !== "object")
                    throw TypeError(".bench.Dialog.ext: object expected");
                message.ext = $root.bench.B2buaDialogExt.fromObject(object.ext, _depth + 1);
            }
            return message;
        };

        /**
         * Creates a plain object from a Dialog message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.Dialog
         * @static
         * @param {bench.Dialog} message Dialog
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Dialog.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.defaults) {
                object.sip = null;
                object.ext = null;
            }
            if (message.sip != null && message.hasOwnProperty("sip"))
                object.sip = $root.bench.StackDialog.toObject(message.sip, options, _depth + 1);
            if (message.ext != null && message.hasOwnProperty("ext"))
                object.ext = $root.bench.B2buaDialogExt.toObject(message.ext, options, _depth + 1);
            return object;
        };

        /**
         * Converts this Dialog to JSON.
         * @function toJSON
         * @memberof bench.Dialog
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Dialog.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for Dialog
         * @function getTypeUrl
         * @memberof bench.Dialog
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        Dialog.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.Dialog";
        };

        return Dialog;
    })();

    bench.Leg = (function() {

        /**
         * Properties of a Leg.
         * @typedef {Object} bench.Leg.$Properties
         * @property {string|null} [legId] Leg legId
         * @property {string|null} [callId] Leg callId
         * @property {string|null} [fromTag] Leg fromTag
         * @property {bench.RemoteInfo.$Properties|null} [source] Leg source
         * @property {string|null} [state] Leg state
         * @property {string|null} [disposition] Leg disposition
         * @property {Array.<bench.Dialog.$Properties>|null} [dialogs] Leg dialogs
         * @property {string|null} [byeDisposition] Leg byeDisposition
         * @property {string|null} [localUri] Leg localUri
         * @property {string|null} [remoteUri] Leg remoteUri
         * @property {string|null} [inviteRequestUri] Leg inviteRequestUri
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a Leg.
         * @memberof bench
         * @interface ILeg
         * @augments bench.Leg.$Properties
         * @deprecated Use bench.Leg.$Properties instead.
         */

        /**
         * Shape of a Leg.
         * @typedef {bench.Leg.$Properties} bench.Leg.$Shape
         */

        /**
         * Constructs a new Leg.
         * @memberof bench
         * @classdesc Represents a Leg.
         * @constructor
         * @param {bench.Leg.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function Leg(properties) {
            this.dialogs = [];
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * Leg legId.
         * @member {string} legId
         * @memberof bench.Leg
         * @instance
         */
        Leg.prototype.legId = "";

        /**
         * Leg callId.
         * @member {string} callId
         * @memberof bench.Leg
         * @instance
         */
        Leg.prototype.callId = "";

        /**
         * Leg fromTag.
         * @member {string} fromTag
         * @memberof bench.Leg
         * @instance
         */
        Leg.prototype.fromTag = "";

        /**
         * Leg source.
         * @member {bench.RemoteInfo.$Properties|null|undefined} source
         * @memberof bench.Leg
         * @instance
         */
        Leg.prototype.source = null;

        /**
         * Leg state.
         * @member {string} state
         * @memberof bench.Leg
         * @instance
         */
        Leg.prototype.state = "";

        /**
         * Leg disposition.
         * @member {string} disposition
         * @memberof bench.Leg
         * @instance
         */
        Leg.prototype.disposition = "";

        /**
         * Leg dialogs.
         * @member {Array.<bench.Dialog.$Properties>} dialogs
         * @memberof bench.Leg
         * @instance
         */
        Leg.prototype.dialogs = $util.emptyArray;

        /**
         * Leg byeDisposition.
         * @member {string|null|undefined} byeDisposition
         * @memberof bench.Leg
         * @instance
         */
        Leg.prototype.byeDisposition = null;

        /**
         * Leg localUri.
         * @member {string|null|undefined} localUri
         * @memberof bench.Leg
         * @instance
         */
        Leg.prototype.localUri = null;

        /**
         * Leg remoteUri.
         * @member {string|null|undefined} remoteUri
         * @memberof bench.Leg
         * @instance
         */
        Leg.prototype.remoteUri = null;

        /**
         * Leg inviteRequestUri.
         * @member {string|null|undefined} inviteRequestUri
         * @memberof bench.Leg
         * @instance
         */
        Leg.prototype.inviteRequestUri = null;

        // OneOf field names bound to virtual getters and setters
        var $oneOfFields;

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Leg.prototype, "_byeDisposition", {
            get: $util.oneOfGetter($oneOfFields = ["byeDisposition"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Leg.prototype, "_localUri", {
            get: $util.oneOfGetter($oneOfFields = ["localUri"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Leg.prototype, "_remoteUri", {
            get: $util.oneOfGetter($oneOfFields = ["remoteUri"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Leg.prototype, "_inviteRequestUri", {
            get: $util.oneOfGetter($oneOfFields = ["inviteRequestUri"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new Leg instance using the specified properties.
         * @function create
         * @memberof bench.Leg
         * @static
         * @param {bench.Leg.$Properties=} [properties] Properties to set
         * @returns {bench.Leg} Leg instance
         * @type {{
         *   (properties: bench.Leg.$Shape): bench.Leg & bench.Leg.$Shape;
         *   (properties?: bench.Leg.$Properties): bench.Leg;
         * }}
         */
        Leg.create = function create(properties) {
            return new Leg(properties);
        };

        /**
         * Encodes the specified Leg message. Does not implicitly {@link bench.Leg.verify|verify} messages.
         * @function encode
         * @memberof bench.Leg
         * @static
         * @param {bench.Leg.$Properties} message Leg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Leg.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.legId != null && Object.hasOwnProperty.call(message, "legId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.legId);
            if (message.callId != null && Object.hasOwnProperty.call(message, "callId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.callId);
            if (message.fromTag != null && Object.hasOwnProperty.call(message, "fromTag"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.fromTag);
            if (message.source != null && Object.hasOwnProperty.call(message, "source"))
                $root.bench.RemoteInfo.encode(message.source, writer.uint32(/* id 4, wireType 2 =*/34).fork(), _depth + 1).ldelim();
            if (message.state != null && Object.hasOwnProperty.call(message, "state"))
                writer.uint32(/* id 5, wireType 2 =*/42).string(message.state);
            if (message.disposition != null && Object.hasOwnProperty.call(message, "disposition"))
                writer.uint32(/* id 6, wireType 2 =*/50).string(message.disposition);
            if (message.dialogs != null && message.dialogs.length)
                for (var i = 0; i < message.dialogs.length; ++i)
                    $root.bench.Dialog.encode(message.dialogs[i], writer.uint32(/* id 7, wireType 2 =*/58).fork(), _depth + 1).ldelim();
            if (message.byeDisposition != null && Object.hasOwnProperty.call(message, "byeDisposition"))
                writer.uint32(/* id 8, wireType 2 =*/66).string(message.byeDisposition);
            if (message.localUri != null && Object.hasOwnProperty.call(message, "localUri"))
                writer.uint32(/* id 9, wireType 2 =*/74).string(message.localUri);
            if (message.remoteUri != null && Object.hasOwnProperty.call(message, "remoteUri"))
                writer.uint32(/* id 10, wireType 2 =*/82).string(message.remoteUri);
            if (message.inviteRequestUri != null && Object.hasOwnProperty.call(message, "inviteRequestUri"))
                writer.uint32(/* id 11, wireType 2 =*/90).string(message.inviteRequestUri);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified Leg message, length delimited. Does not implicitly {@link bench.Leg.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.Leg
         * @static
         * @param {bench.Leg.$Properties} message Leg message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Leg.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a Leg message from the specified reader or buffer.
         * @function decode
         * @memberof bench.Leg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.Leg & bench.Leg.$Shape} Leg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Leg.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.Leg(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.legId = value;
                        else
                            delete message.legId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.callId = value;
                        else
                            delete message.callId;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.fromTag = value;
                        else
                            delete message.fromTag;
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        message.source = $root.bench.RemoteInfo.decode(reader, reader.uint32(), undefined, _depth + 1, message.source);
                        continue;
                    }
                case 5: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.state = value;
                        else
                            delete message.state;
                        continue;
                    }
                case 6: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.disposition = value;
                        else
                            delete message.disposition;
                        continue;
                    }
                case 7: {
                        if (wireType !== 2)
                            break;
                        if (!(message.dialogs && message.dialogs.length))
                            message.dialogs = [];
                        message.dialogs.push($root.bench.Dialog.decode(reader, reader.uint32(), undefined, _depth + 1));
                        continue;
                    }
                case 8: {
                        if (wireType !== 2)
                            break;
                        message.byeDisposition = reader.string();
                        message._byeDisposition = "byeDisposition";
                        continue;
                    }
                case 9: {
                        if (wireType !== 2)
                            break;
                        message.localUri = reader.string();
                        message._localUri = "localUri";
                        continue;
                    }
                case 10: {
                        if (wireType !== 2)
                            break;
                        message.remoteUri = reader.string();
                        message._remoteUri = "remoteUri";
                        continue;
                    }
                case 11: {
                        if (wireType !== 2)
                            break;
                        message.inviteRequestUri = reader.string();
                        message._inviteRequestUri = "inviteRequestUri";
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a Leg message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.Leg
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.Leg & bench.Leg.$Shape} Leg
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Leg.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Leg message.
         * @function verify
         * @memberof bench.Leg
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Leg.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            var properties = {};
            if (message.legId != null && message.hasOwnProperty("legId"))
                if (!$util.isString(message.legId))
                    return "legId: string expected";
            if (message.callId != null && message.hasOwnProperty("callId"))
                if (!$util.isString(message.callId))
                    return "callId: string expected";
            if (message.fromTag != null && message.hasOwnProperty("fromTag"))
                if (!$util.isString(message.fromTag))
                    return "fromTag: string expected";
            if (message.source != null && message.hasOwnProperty("source")) {
                var error = $root.bench.RemoteInfo.verify(message.source, _depth + 1);
                if (error)
                    return "source." + error;
            }
            if (message.state != null && message.hasOwnProperty("state"))
                if (!$util.isString(message.state))
                    return "state: string expected";
            if (message.disposition != null && message.hasOwnProperty("disposition"))
                if (!$util.isString(message.disposition))
                    return "disposition: string expected";
            if (message.dialogs != null && message.hasOwnProperty("dialogs")) {
                if (!Array.isArray(message.dialogs))
                    return "dialogs: array expected";
                for (var i = 0; i < message.dialogs.length; ++i) {
                    var error = $root.bench.Dialog.verify(message.dialogs[i], _depth + 1);
                    if (error)
                        return "dialogs." + error;
                }
            }
            if (message.byeDisposition != null && message.hasOwnProperty("byeDisposition")) {
                properties._byeDisposition = 1;
                if (!$util.isString(message.byeDisposition))
                    return "byeDisposition: string expected";
            }
            if (message.localUri != null && message.hasOwnProperty("localUri")) {
                properties._localUri = 1;
                if (!$util.isString(message.localUri))
                    return "localUri: string expected";
            }
            if (message.remoteUri != null && message.hasOwnProperty("remoteUri")) {
                properties._remoteUri = 1;
                if (!$util.isString(message.remoteUri))
                    return "remoteUri: string expected";
            }
            if (message.inviteRequestUri != null && message.hasOwnProperty("inviteRequestUri")) {
                properties._inviteRequestUri = 1;
                if (!$util.isString(message.inviteRequestUri))
                    return "inviteRequestUri: string expected";
            }
            return null;
        };

        /**
         * Creates a Leg message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.Leg
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.Leg} Leg
         */
        Leg.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.Leg)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.Leg();
            if (object.legId != null)
                if (typeof object.legId !== "string" || object.legId.length)
                    message.legId = String(object.legId);
            if (object.callId != null)
                if (typeof object.callId !== "string" || object.callId.length)
                    message.callId = String(object.callId);
            if (object.fromTag != null)
                if (typeof object.fromTag !== "string" || object.fromTag.length)
                    message.fromTag = String(object.fromTag);
            if (object.source != null) {
                if (typeof object.source !== "object")
                    throw TypeError(".bench.Leg.source: object expected");
                message.source = $root.bench.RemoteInfo.fromObject(object.source, _depth + 1);
            }
            if (object.state != null)
                if (typeof object.state !== "string" || object.state.length)
                    message.state = String(object.state);
            if (object.disposition != null)
                if (typeof object.disposition !== "string" || object.disposition.length)
                    message.disposition = String(object.disposition);
            if (object.dialogs) {
                if (!Array.isArray(object.dialogs))
                    throw TypeError(".bench.Leg.dialogs: array expected");
                message.dialogs = Array(object.dialogs.length);
                for (var i = 0; i < object.dialogs.length; ++i) {
                    if (typeof object.dialogs[i] !== "object")
                        throw TypeError(".bench.Leg.dialogs: object expected");
                    message.dialogs[i] = $root.bench.Dialog.fromObject(object.dialogs[i], _depth + 1);
                }
            }
            if (object.byeDisposition != null)
                message.byeDisposition = String(object.byeDisposition);
            if (object.localUri != null)
                message.localUri = String(object.localUri);
            if (object.remoteUri != null)
                message.remoteUri = String(object.remoteUri);
            if (object.inviteRequestUri != null)
                message.inviteRequestUri = String(object.inviteRequestUri);
            return message;
        };

        /**
         * Creates a plain object from a Leg message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.Leg
         * @static
         * @param {bench.Leg} message Leg
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Leg.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.arrays || options.defaults)
                object.dialogs = [];
            if (options.defaults) {
                object.legId = "";
                object.callId = "";
                object.fromTag = "";
                object.source = null;
                object.state = "";
                object.disposition = "";
            }
            if (message.legId != null && message.hasOwnProperty("legId"))
                object.legId = message.legId;
            if (message.callId != null && message.hasOwnProperty("callId"))
                object.callId = message.callId;
            if (message.fromTag != null && message.hasOwnProperty("fromTag"))
                object.fromTag = message.fromTag;
            if (message.source != null && message.hasOwnProperty("source"))
                object.source = $root.bench.RemoteInfo.toObject(message.source, options, _depth + 1);
            if (message.state != null && message.hasOwnProperty("state"))
                object.state = message.state;
            if (message.disposition != null && message.hasOwnProperty("disposition"))
                object.disposition = message.disposition;
            if (message.dialogs && message.dialogs.length) {
                object.dialogs = Array(message.dialogs.length);
                for (var j = 0; j < message.dialogs.length; ++j)
                    object.dialogs[j] = $root.bench.Dialog.toObject(message.dialogs[j], options, _depth + 1);
            }
            if (message.byeDisposition != null && message.hasOwnProperty("byeDisposition"))
                object.byeDisposition = message.byeDisposition;
            if (message.localUri != null && message.hasOwnProperty("localUri"))
                object.localUri = message.localUri;
            if (message.remoteUri != null && message.hasOwnProperty("remoteUri"))
                object.remoteUri = message.remoteUri;
            if (message.inviteRequestUri != null && message.hasOwnProperty("inviteRequestUri"))
                object.inviteRequestUri = message.inviteRequestUri;
            return object;
        };

        /**
         * Converts this Leg to JSON.
         * @function toJSON
         * @memberof bench.Leg
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Leg.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for Leg
         * @function getTypeUrl
         * @memberof bench.Leg
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        Leg.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.Leg";
        };

        return Leg;
    })();

    bench.ALegInvite = (function() {

        /**
         * Properties of a ALegInvite.
         * @typedef {Object} bench.ALegInvite.$Properties
         * @property {string|null} [uri] ALegInvite uri
         * @property {Array.<bench.SipHeader.$Properties>|null} [headers] ALegInvite headers
         * @property {Uint8Array|null} [body] ALegInvite body
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a ALegInvite.
         * @memberof bench
         * @interface IALegInvite
         * @augments bench.ALegInvite.$Properties
         * @deprecated Use bench.ALegInvite.$Properties instead.
         */

        /**
         * Shape of a ALegInvite.
         * @typedef {bench.ALegInvite.$Properties} bench.ALegInvite.$Shape
         */

        /**
         * Constructs a new ALegInvite.
         * @memberof bench
         * @classdesc Represents a ALegInvite.
         * @constructor
         * @param {bench.ALegInvite.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function ALegInvite(properties) {
            this.headers = [];
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * ALegInvite uri.
         * @member {string} uri
         * @memberof bench.ALegInvite
         * @instance
         */
        ALegInvite.prototype.uri = "";

        /**
         * ALegInvite headers.
         * @member {Array.<bench.SipHeader.$Properties>} headers
         * @memberof bench.ALegInvite
         * @instance
         */
        ALegInvite.prototype.headers = $util.emptyArray;

        /**
         * ALegInvite body.
         * @member {Uint8Array} body
         * @memberof bench.ALegInvite
         * @instance
         */
        ALegInvite.prototype.body = $util.newBuffer([]);

        /**
         * Creates a new ALegInvite instance using the specified properties.
         * @function create
         * @memberof bench.ALegInvite
         * @static
         * @param {bench.ALegInvite.$Properties=} [properties] Properties to set
         * @returns {bench.ALegInvite} ALegInvite instance
         * @type {{
         *   (properties: bench.ALegInvite.$Shape): bench.ALegInvite & bench.ALegInvite.$Shape;
         *   (properties?: bench.ALegInvite.$Properties): bench.ALegInvite;
         * }}
         */
        ALegInvite.create = function create(properties) {
            return new ALegInvite(properties);
        };

        /**
         * Encodes the specified ALegInvite message. Does not implicitly {@link bench.ALegInvite.verify|verify} messages.
         * @function encode
         * @memberof bench.ALegInvite
         * @static
         * @param {bench.ALegInvite.$Properties} message ALegInvite message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ALegInvite.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.uri != null && Object.hasOwnProperty.call(message, "uri"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.uri);
            if (message.headers != null && message.headers.length)
                for (var i = 0; i < message.headers.length; ++i)
                    $root.bench.SipHeader.encode(message.headers[i], writer.uint32(/* id 2, wireType 2 =*/18).fork(), _depth + 1).ldelim();
            if (message.body != null && Object.hasOwnProperty.call(message, "body"))
                writer.uint32(/* id 3, wireType 2 =*/26).bytes(message.body);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified ALegInvite message, length delimited. Does not implicitly {@link bench.ALegInvite.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.ALegInvite
         * @static
         * @param {bench.ALegInvite.$Properties} message ALegInvite message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ALegInvite.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a ALegInvite message from the specified reader or buffer.
         * @function decode
         * @memberof bench.ALegInvite
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.ALegInvite & bench.ALegInvite.$Shape} ALegInvite
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ALegInvite.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.ALegInvite(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.uri = value;
                        else
                            delete message.uri;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if (!(message.headers && message.headers.length))
                            message.headers = [];
                        message.headers.push($root.bench.SipHeader.decode(reader, reader.uint32(), undefined, _depth + 1));
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.bytes()).length)
                            message.body = value;
                        else
                            delete message.body;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a ALegInvite message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.ALegInvite
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.ALegInvite & bench.ALegInvite.$Shape} ALegInvite
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ALegInvite.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a ALegInvite message.
         * @function verify
         * @memberof bench.ALegInvite
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        ALegInvite.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.uri != null && message.hasOwnProperty("uri"))
                if (!$util.isString(message.uri))
                    return "uri: string expected";
            if (message.headers != null && message.hasOwnProperty("headers")) {
                if (!Array.isArray(message.headers))
                    return "headers: array expected";
                for (var i = 0; i < message.headers.length; ++i) {
                    var error = $root.bench.SipHeader.verify(message.headers[i], _depth + 1);
                    if (error)
                        return "headers." + error;
                }
            }
            if (message.body != null && message.hasOwnProperty("body"))
                if (!(message.body && typeof message.body.length === "number" || $util.isString(message.body)))
                    return "body: buffer expected";
            return null;
        };

        /**
         * Creates a ALegInvite message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.ALegInvite
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.ALegInvite} ALegInvite
         */
        ALegInvite.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.ALegInvite)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.ALegInvite();
            if (object.uri != null)
                if (typeof object.uri !== "string" || object.uri.length)
                    message.uri = String(object.uri);
            if (object.headers) {
                if (!Array.isArray(object.headers))
                    throw TypeError(".bench.ALegInvite.headers: array expected");
                message.headers = Array(object.headers.length);
                for (var i = 0; i < object.headers.length; ++i) {
                    if (typeof object.headers[i] !== "object")
                        throw TypeError(".bench.ALegInvite.headers: object expected");
                    message.headers[i] = $root.bench.SipHeader.fromObject(object.headers[i], _depth + 1);
                }
            }
            if (object.body != null)
                if (object.body.length)
                    if (typeof object.body === "string")
                        $util.base64.decode(object.body, message.body = $util.newBuffer($util.base64.length(object.body)), 0);
                    else if (object.body.length >= 0)
                        message.body = object.body;
            return message;
        };

        /**
         * Creates a plain object from a ALegInvite message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.ALegInvite
         * @static
         * @param {bench.ALegInvite} message ALegInvite
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        ALegInvite.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.arrays || options.defaults)
                object.headers = [];
            if (options.defaults) {
                object.uri = "";
                if (options.bytes === String)
                    object.body = "";
                else {
                    object.body = [];
                    if (options.bytes !== Array)
                        object.body = $util.newBuffer(object.body);
                }
            }
            if (message.uri != null && message.hasOwnProperty("uri"))
                object.uri = message.uri;
            if (message.headers && message.headers.length) {
                object.headers = Array(message.headers.length);
                for (var j = 0; j < message.headers.length; ++j)
                    object.headers[j] = $root.bench.SipHeader.toObject(message.headers[j], options, _depth + 1);
            }
            if (message.body != null && message.hasOwnProperty("body"))
                object.body = options.bytes === String ? $util.base64.encode(message.body, 0, message.body.length) : options.bytes === Array ? Array.prototype.slice.call(message.body) : message.body;
            return object;
        };

        /**
         * Converts this ALegInvite to JSON.
         * @function toJSON
         * @memberof bench.ALegInvite
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        ALegInvite.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for ALegInvite
         * @function getTypeUrl
         * @memberof bench.ALegInvite
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        ALegInvite.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.ALegInvite";
        };

        return ALegInvite;
    })();

    bench.TagMapping = (function() {

        /**
         * Properties of a TagMapping.
         * @typedef {Object} bench.TagMapping.$Properties
         * @property {string|null} [aTag] TagMapping aTag
         * @property {string|null} [bLegId] TagMapping bLegId
         * @property {string|null} [bTag] TagMapping bTag
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a TagMapping.
         * @memberof bench
         * @interface ITagMapping
         * @augments bench.TagMapping.$Properties
         * @deprecated Use bench.TagMapping.$Properties instead.
         */

        /**
         * Shape of a TagMapping.
         * @typedef {bench.TagMapping.$Properties} bench.TagMapping.$Shape
         */

        /**
         * Constructs a new TagMapping.
         * @memberof bench
         * @classdesc Represents a TagMapping.
         * @constructor
         * @param {bench.TagMapping.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function TagMapping(properties) {
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * TagMapping aTag.
         * @member {string} aTag
         * @memberof bench.TagMapping
         * @instance
         */
        TagMapping.prototype.aTag = "";

        /**
         * TagMapping bLegId.
         * @member {string} bLegId
         * @memberof bench.TagMapping
         * @instance
         */
        TagMapping.prototype.bLegId = "";

        /**
         * TagMapping bTag.
         * @member {string} bTag
         * @memberof bench.TagMapping
         * @instance
         */
        TagMapping.prototype.bTag = "";

        /**
         * Creates a new TagMapping instance using the specified properties.
         * @function create
         * @memberof bench.TagMapping
         * @static
         * @param {bench.TagMapping.$Properties=} [properties] Properties to set
         * @returns {bench.TagMapping} TagMapping instance
         * @type {{
         *   (properties: bench.TagMapping.$Shape): bench.TagMapping & bench.TagMapping.$Shape;
         *   (properties?: bench.TagMapping.$Properties): bench.TagMapping;
         * }}
         */
        TagMapping.create = function create(properties) {
            return new TagMapping(properties);
        };

        /**
         * Encodes the specified TagMapping message. Does not implicitly {@link bench.TagMapping.verify|verify} messages.
         * @function encode
         * @memberof bench.TagMapping
         * @static
         * @param {bench.TagMapping.$Properties} message TagMapping message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TagMapping.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.aTag != null && Object.hasOwnProperty.call(message, "aTag"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.aTag);
            if (message.bLegId != null && Object.hasOwnProperty.call(message, "bLegId"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.bLegId);
            if (message.bTag != null && Object.hasOwnProperty.call(message, "bTag"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.bTag);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified TagMapping message, length delimited. Does not implicitly {@link bench.TagMapping.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.TagMapping
         * @static
         * @param {bench.TagMapping.$Properties} message TagMapping message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TagMapping.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a TagMapping message from the specified reader or buffer.
         * @function decode
         * @memberof bench.TagMapping
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.TagMapping & bench.TagMapping.$Shape} TagMapping
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TagMapping.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.TagMapping(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.aTag = value;
                        else
                            delete message.aTag;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.bLegId = value;
                        else
                            delete message.bLegId;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.bTag = value;
                        else
                            delete message.bTag;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a TagMapping message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.TagMapping
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.TagMapping & bench.TagMapping.$Shape} TagMapping
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TagMapping.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a TagMapping message.
         * @function verify
         * @memberof bench.TagMapping
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        TagMapping.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.aTag != null && message.hasOwnProperty("aTag"))
                if (!$util.isString(message.aTag))
                    return "aTag: string expected";
            if (message.bLegId != null && message.hasOwnProperty("bLegId"))
                if (!$util.isString(message.bLegId))
                    return "bLegId: string expected";
            if (message.bTag != null && message.hasOwnProperty("bTag"))
                if (!$util.isString(message.bTag))
                    return "bTag: string expected";
            return null;
        };

        /**
         * Creates a TagMapping message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.TagMapping
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.TagMapping} TagMapping
         */
        TagMapping.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.TagMapping)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.TagMapping();
            if (object.aTag != null)
                if (typeof object.aTag !== "string" || object.aTag.length)
                    message.aTag = String(object.aTag);
            if (object.bLegId != null)
                if (typeof object.bLegId !== "string" || object.bLegId.length)
                    message.bLegId = String(object.bLegId);
            if (object.bTag != null)
                if (typeof object.bTag !== "string" || object.bTag.length)
                    message.bTag = String(object.bTag);
            return message;
        };

        /**
         * Creates a plain object from a TagMapping message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.TagMapping
         * @static
         * @param {bench.TagMapping} message TagMapping
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        TagMapping.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.defaults) {
                object.aTag = "";
                object.bLegId = "";
                object.bTag = "";
            }
            if (message.aTag != null && message.hasOwnProperty("aTag"))
                object.aTag = message.aTag;
            if (message.bLegId != null && message.hasOwnProperty("bLegId"))
                object.bLegId = message.bLegId;
            if (message.bTag != null && message.hasOwnProperty("bTag"))
                object.bTag = message.bTag;
            return object;
        };

        /**
         * Converts this TagMapping to JSON.
         * @function toJSON
         * @memberof bench.TagMapping
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        TagMapping.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for TagMapping
         * @function getTypeUrl
         * @memberof bench.TagMapping
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        TagMapping.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.TagMapping";
        };

        return TagMapping;
    })();

    bench.CallLimiterState = (function() {

        /**
         * Properties of a CallLimiterState.
         * @typedef {Object} bench.CallLimiterState.$Properties
         * @property {string|null} [limiterId] CallLimiterState limiterId
         * @property {number|null} [limit] CallLimiterState limit
         * @property {number|null} [originWindow] CallLimiterState originWindow
         * @property {boolean|null} [incrementSucceeded] CallLimiterState incrementSucceeded
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a CallLimiterState.
         * @memberof bench
         * @interface ICallLimiterState
         * @augments bench.CallLimiterState.$Properties
         * @deprecated Use bench.CallLimiterState.$Properties instead.
         */

        /**
         * Shape of a CallLimiterState.
         * @typedef {bench.CallLimiterState.$Properties} bench.CallLimiterState.$Shape
         */

        /**
         * Constructs a new CallLimiterState.
         * @memberof bench
         * @classdesc Represents a CallLimiterState.
         * @constructor
         * @param {bench.CallLimiterState.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function CallLimiterState(properties) {
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * CallLimiterState limiterId.
         * @member {string} limiterId
         * @memberof bench.CallLimiterState
         * @instance
         */
        CallLimiterState.prototype.limiterId = "";

        /**
         * CallLimiterState limit.
         * @member {number} limit
         * @memberof bench.CallLimiterState
         * @instance
         */
        CallLimiterState.prototype.limit = 0;

        /**
         * CallLimiterState originWindow.
         * @member {number} originWindow
         * @memberof bench.CallLimiterState
         * @instance
         */
        CallLimiterState.prototype.originWindow = 0;

        /**
         * CallLimiterState incrementSucceeded.
         * @member {boolean|null|undefined} incrementSucceeded
         * @memberof bench.CallLimiterState
         * @instance
         */
        CallLimiterState.prototype.incrementSucceeded = null;

        // OneOf field names bound to virtual getters and setters
        var $oneOfFields;

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(CallLimiterState.prototype, "_incrementSucceeded", {
            get: $util.oneOfGetter($oneOfFields = ["incrementSucceeded"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new CallLimiterState instance using the specified properties.
         * @function create
         * @memberof bench.CallLimiterState
         * @static
         * @param {bench.CallLimiterState.$Properties=} [properties] Properties to set
         * @returns {bench.CallLimiterState} CallLimiterState instance
         * @type {{
         *   (properties: bench.CallLimiterState.$Shape): bench.CallLimiterState & bench.CallLimiterState.$Shape;
         *   (properties?: bench.CallLimiterState.$Properties): bench.CallLimiterState;
         * }}
         */
        CallLimiterState.create = function create(properties) {
            return new CallLimiterState(properties);
        };

        /**
         * Encodes the specified CallLimiterState message. Does not implicitly {@link bench.CallLimiterState.verify|verify} messages.
         * @function encode
         * @memberof bench.CallLimiterState
         * @static
         * @param {bench.CallLimiterState.$Properties} message CallLimiterState message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CallLimiterState.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.limiterId != null && Object.hasOwnProperty.call(message, "limiterId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.limiterId);
            if (message.limit != null && Object.hasOwnProperty.call(message, "limit"))
                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.limit);
            if (message.originWindow != null && Object.hasOwnProperty.call(message, "originWindow"))
                writer.uint32(/* id 3, wireType 1 =*/25).double(message.originWindow);
            if (message.incrementSucceeded != null && Object.hasOwnProperty.call(message, "incrementSucceeded"))
                writer.uint32(/* id 4, wireType 0 =*/32).bool(message.incrementSucceeded);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified CallLimiterState message, length delimited. Does not implicitly {@link bench.CallLimiterState.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.CallLimiterState
         * @static
         * @param {bench.CallLimiterState.$Properties} message CallLimiterState message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CallLimiterState.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a CallLimiterState message from the specified reader or buffer.
         * @function decode
         * @memberof bench.CallLimiterState
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.CallLimiterState & bench.CallLimiterState.$Shape} CallLimiterState
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CallLimiterState.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.CallLimiterState(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.limiterId = value;
                        else
                            delete message.limiterId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.int32())
                            message.limit = value;
                        else
                            delete message.limit;
                        continue;
                    }
                case 3: {
                        if (wireType !== 1)
                            break;
                        if ((value = reader.double()) !== 0)
                            message.originWindow = value;
                        else
                            delete message.originWindow;
                        continue;
                    }
                case 4: {
                        if (wireType !== 0)
                            break;
                        message.incrementSucceeded = reader.bool();
                        message._incrementSucceeded = "incrementSucceeded";
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a CallLimiterState message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.CallLimiterState
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.CallLimiterState & bench.CallLimiterState.$Shape} CallLimiterState
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CallLimiterState.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a CallLimiterState message.
         * @function verify
         * @memberof bench.CallLimiterState
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        CallLimiterState.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            var properties = {};
            if (message.limiterId != null && message.hasOwnProperty("limiterId"))
                if (!$util.isString(message.limiterId))
                    return "limiterId: string expected";
            if (message.limit != null && message.hasOwnProperty("limit"))
                if (!$util.isInteger(message.limit))
                    return "limit: integer expected";
            if (message.originWindow != null && message.hasOwnProperty("originWindow"))
                if (typeof message.originWindow !== "number")
                    return "originWindow: number expected";
            if (message.incrementSucceeded != null && message.hasOwnProperty("incrementSucceeded")) {
                properties._incrementSucceeded = 1;
                if (typeof message.incrementSucceeded !== "boolean")
                    return "incrementSucceeded: boolean expected";
            }
            return null;
        };

        /**
         * Creates a CallLimiterState message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.CallLimiterState
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.CallLimiterState} CallLimiterState
         */
        CallLimiterState.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.CallLimiterState)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.CallLimiterState();
            if (object.limiterId != null)
                if (typeof object.limiterId !== "string" || object.limiterId.length)
                    message.limiterId = String(object.limiterId);
            if (object.limit != null)
                if (Number(object.limit) !== 0)
                    message.limit = object.limit | 0;
            if (object.originWindow != null)
                if (Number(object.originWindow) !== 0)
                    message.originWindow = Number(object.originWindow);
            if (object.incrementSucceeded != null)
                message.incrementSucceeded = Boolean(object.incrementSucceeded);
            return message;
        };

        /**
         * Creates a plain object from a CallLimiterState message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.CallLimiterState
         * @static
         * @param {bench.CallLimiterState} message CallLimiterState
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        CallLimiterState.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.defaults) {
                object.limiterId = "";
                object.limit = 0;
                object.originWindow = 0;
            }
            if (message.limiterId != null && message.hasOwnProperty("limiterId"))
                object.limiterId = message.limiterId;
            if (message.limit != null && message.hasOwnProperty("limit"))
                object.limit = message.limit;
            if (message.originWindow != null && message.hasOwnProperty("originWindow"))
                object.originWindow = options.json && !isFinite(message.originWindow) ? String(message.originWindow) : message.originWindow;
            if (message.incrementSucceeded != null && message.hasOwnProperty("incrementSucceeded"))
                object.incrementSucceeded = message.incrementSucceeded;
            return object;
        };

        /**
         * Converts this CallLimiterState to JSON.
         * @function toJSON
         * @memberof bench.CallLimiterState
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        CallLimiterState.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for CallLimiterState
         * @function getTypeUrl
         * @memberof bench.CallLimiterState
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        CallLimiterState.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.CallLimiterState";
        };

        return CallLimiterState;
    })();

    bench.TimerEntry = (function() {

        /**
         * Properties of a TimerEntry.
         * @typedef {Object} bench.TimerEntry.$Properties
         * @property {string|null} [id] TimerEntry id
         * @property {string|null} [type] TimerEntry type
         * @property {number|null} [fireAt] TimerEntry fireAt
         * @property {string|null} [legId] TimerEntry legId
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a TimerEntry.
         * @memberof bench
         * @interface ITimerEntry
         * @augments bench.TimerEntry.$Properties
         * @deprecated Use bench.TimerEntry.$Properties instead.
         */

        /**
         * Shape of a TimerEntry.
         * @typedef {bench.TimerEntry.$Properties} bench.TimerEntry.$Shape
         */

        /**
         * Constructs a new TimerEntry.
         * @memberof bench
         * @classdesc Represents a TimerEntry.
         * @constructor
         * @param {bench.TimerEntry.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function TimerEntry(properties) {
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * TimerEntry id.
         * @member {string} id
         * @memberof bench.TimerEntry
         * @instance
         */
        TimerEntry.prototype.id = "";

        /**
         * TimerEntry type.
         * @member {string} type
         * @memberof bench.TimerEntry
         * @instance
         */
        TimerEntry.prototype.type = "";

        /**
         * TimerEntry fireAt.
         * @member {number} fireAt
         * @memberof bench.TimerEntry
         * @instance
         */
        TimerEntry.prototype.fireAt = 0;

        /**
         * TimerEntry legId.
         * @member {string|null|undefined} legId
         * @memberof bench.TimerEntry
         * @instance
         */
        TimerEntry.prototype.legId = null;

        // OneOf field names bound to virtual getters and setters
        var $oneOfFields;

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(TimerEntry.prototype, "_legId", {
            get: $util.oneOfGetter($oneOfFields = ["legId"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new TimerEntry instance using the specified properties.
         * @function create
         * @memberof bench.TimerEntry
         * @static
         * @param {bench.TimerEntry.$Properties=} [properties] Properties to set
         * @returns {bench.TimerEntry} TimerEntry instance
         * @type {{
         *   (properties: bench.TimerEntry.$Shape): bench.TimerEntry & bench.TimerEntry.$Shape;
         *   (properties?: bench.TimerEntry.$Properties): bench.TimerEntry;
         * }}
         */
        TimerEntry.create = function create(properties) {
            return new TimerEntry(properties);
        };

        /**
         * Encodes the specified TimerEntry message. Does not implicitly {@link bench.TimerEntry.verify|verify} messages.
         * @function encode
         * @memberof bench.TimerEntry
         * @static
         * @param {bench.TimerEntry.$Properties} message TimerEntry message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TimerEntry.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.id);
            if (message.type != null && Object.hasOwnProperty.call(message, "type"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.type);
            if (message.fireAt != null && Object.hasOwnProperty.call(message, "fireAt"))
                writer.uint32(/* id 3, wireType 1 =*/25).double(message.fireAt);
            if (message.legId != null && Object.hasOwnProperty.call(message, "legId"))
                writer.uint32(/* id 4, wireType 2 =*/34).string(message.legId);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified TimerEntry message, length delimited. Does not implicitly {@link bench.TimerEntry.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.TimerEntry
         * @static
         * @param {bench.TimerEntry.$Properties} message TimerEntry message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        TimerEntry.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a TimerEntry message from the specified reader or buffer.
         * @function decode
         * @memberof bench.TimerEntry
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.TimerEntry & bench.TimerEntry.$Shape} TimerEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TimerEntry.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.TimerEntry(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.id = value;
                        else
                            delete message.id;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.type = value;
                        else
                            delete message.type;
                        continue;
                    }
                case 3: {
                        if (wireType !== 1)
                            break;
                        if ((value = reader.double()) !== 0)
                            message.fireAt = value;
                        else
                            delete message.fireAt;
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        message.legId = reader.string();
                        message._legId = "legId";
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a TimerEntry message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.TimerEntry
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.TimerEntry & bench.TimerEntry.$Shape} TimerEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        TimerEntry.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a TimerEntry message.
         * @function verify
         * @memberof bench.TimerEntry
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        TimerEntry.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            var properties = {};
            if (message.id != null && message.hasOwnProperty("id"))
                if (!$util.isString(message.id))
                    return "id: string expected";
            if (message.type != null && message.hasOwnProperty("type"))
                if (!$util.isString(message.type))
                    return "type: string expected";
            if (message.fireAt != null && message.hasOwnProperty("fireAt"))
                if (typeof message.fireAt !== "number")
                    return "fireAt: number expected";
            if (message.legId != null && message.hasOwnProperty("legId")) {
                properties._legId = 1;
                if (!$util.isString(message.legId))
                    return "legId: string expected";
            }
            return null;
        };

        /**
         * Creates a TimerEntry message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.TimerEntry
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.TimerEntry} TimerEntry
         */
        TimerEntry.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.TimerEntry)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.TimerEntry();
            if (object.id != null)
                if (typeof object.id !== "string" || object.id.length)
                    message.id = String(object.id);
            if (object.type != null)
                if (typeof object.type !== "string" || object.type.length)
                    message.type = String(object.type);
            if (object.fireAt != null)
                if (Number(object.fireAt) !== 0)
                    message.fireAt = Number(object.fireAt);
            if (object.legId != null)
                message.legId = String(object.legId);
            return message;
        };

        /**
         * Creates a plain object from a TimerEntry message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.TimerEntry
         * @static
         * @param {bench.TimerEntry} message TimerEntry
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        TimerEntry.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.defaults) {
                object.id = "";
                object.type = "";
                object.fireAt = 0;
            }
            if (message.id != null && message.hasOwnProperty("id"))
                object.id = message.id;
            if (message.type != null && message.hasOwnProperty("type"))
                object.type = message.type;
            if (message.fireAt != null && message.hasOwnProperty("fireAt"))
                object.fireAt = options.json && !isFinite(message.fireAt) ? String(message.fireAt) : message.fireAt;
            if (message.legId != null && message.hasOwnProperty("legId"))
                object.legId = message.legId;
            return object;
        };

        /**
         * Converts this TimerEntry to JSON.
         * @function toJSON
         * @memberof bench.TimerEntry
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        TimerEntry.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for TimerEntry
         * @function getTypeUrl
         * @memberof bench.TimerEntry
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        TimerEntry.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.TimerEntry";
        };

        return TimerEntry;
    })();

    bench.CdrEvent = (function() {

        /**
         * Properties of a CdrEvent.
         * @typedef {Object} bench.CdrEvent.$Properties
         * @property {string|null} [type] CdrEvent type
         * @property {number|null} [timestamp] CdrEvent timestamp
         * @property {string|null} [legId] CdrEvent legId
         * @property {number|null} [statusCode] CdrEvent statusCode
         * @property {string|null} [reason] CdrEvent reason
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a CdrEvent.
         * @memberof bench
         * @interface ICdrEvent
         * @augments bench.CdrEvent.$Properties
         * @deprecated Use bench.CdrEvent.$Properties instead.
         */

        /**
         * Shape of a CdrEvent.
         * @typedef {bench.CdrEvent.$Properties} bench.CdrEvent.$Shape
         */

        /**
         * Constructs a new CdrEvent.
         * @memberof bench
         * @classdesc Represents a CdrEvent.
         * @constructor
         * @param {bench.CdrEvent.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function CdrEvent(properties) {
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * CdrEvent type.
         * @member {string} type
         * @memberof bench.CdrEvent
         * @instance
         */
        CdrEvent.prototype.type = "";

        /**
         * CdrEvent timestamp.
         * @member {number} timestamp
         * @memberof bench.CdrEvent
         * @instance
         */
        CdrEvent.prototype.timestamp = 0;

        /**
         * CdrEvent legId.
         * @member {string} legId
         * @memberof bench.CdrEvent
         * @instance
         */
        CdrEvent.prototype.legId = "";

        /**
         * CdrEvent statusCode.
         * @member {number|null|undefined} statusCode
         * @memberof bench.CdrEvent
         * @instance
         */
        CdrEvent.prototype.statusCode = null;

        /**
         * CdrEvent reason.
         * @member {string|null|undefined} reason
         * @memberof bench.CdrEvent
         * @instance
         */
        CdrEvent.prototype.reason = null;

        // OneOf field names bound to virtual getters and setters
        var $oneOfFields;

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(CdrEvent.prototype, "_statusCode", {
            get: $util.oneOfGetter($oneOfFields = ["statusCode"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(CdrEvent.prototype, "_reason", {
            get: $util.oneOfGetter($oneOfFields = ["reason"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new CdrEvent instance using the specified properties.
         * @function create
         * @memberof bench.CdrEvent
         * @static
         * @param {bench.CdrEvent.$Properties=} [properties] Properties to set
         * @returns {bench.CdrEvent} CdrEvent instance
         * @type {{
         *   (properties: bench.CdrEvent.$Shape): bench.CdrEvent & bench.CdrEvent.$Shape;
         *   (properties?: bench.CdrEvent.$Properties): bench.CdrEvent;
         * }}
         */
        CdrEvent.create = function create(properties) {
            return new CdrEvent(properties);
        };

        /**
         * Encodes the specified CdrEvent message. Does not implicitly {@link bench.CdrEvent.verify|verify} messages.
         * @function encode
         * @memberof bench.CdrEvent
         * @static
         * @param {bench.CdrEvent.$Properties} message CdrEvent message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CdrEvent.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.type != null && Object.hasOwnProperty.call(message, "type"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.type);
            if (message.timestamp != null && Object.hasOwnProperty.call(message, "timestamp"))
                writer.uint32(/* id 2, wireType 1 =*/17).double(message.timestamp);
            if (message.legId != null && Object.hasOwnProperty.call(message, "legId"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.legId);
            if (message.statusCode != null && Object.hasOwnProperty.call(message, "statusCode"))
                writer.uint32(/* id 4, wireType 0 =*/32).int32(message.statusCode);
            if (message.reason != null && Object.hasOwnProperty.call(message, "reason"))
                writer.uint32(/* id 5, wireType 2 =*/42).string(message.reason);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified CdrEvent message, length delimited. Does not implicitly {@link bench.CdrEvent.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.CdrEvent
         * @static
         * @param {bench.CdrEvent.$Properties} message CdrEvent message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CdrEvent.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a CdrEvent message from the specified reader or buffer.
         * @function decode
         * @memberof bench.CdrEvent
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.CdrEvent & bench.CdrEvent.$Shape} CdrEvent
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CdrEvent.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.CdrEvent(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.type = value;
                        else
                            delete message.type;
                        continue;
                    }
                case 2: {
                        if (wireType !== 1)
                            break;
                        if ((value = reader.double()) !== 0)
                            message.timestamp = value;
                        else
                            delete message.timestamp;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.legId = value;
                        else
                            delete message.legId;
                        continue;
                    }
                case 4: {
                        if (wireType !== 0)
                            break;
                        message.statusCode = reader.int32();
                        message._statusCode = "statusCode";
                        continue;
                    }
                case 5: {
                        if (wireType !== 2)
                            break;
                        message.reason = reader.string();
                        message._reason = "reason";
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a CdrEvent message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.CdrEvent
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.CdrEvent & bench.CdrEvent.$Shape} CdrEvent
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CdrEvent.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a CdrEvent message.
         * @function verify
         * @memberof bench.CdrEvent
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        CdrEvent.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            var properties = {};
            if (message.type != null && message.hasOwnProperty("type"))
                if (!$util.isString(message.type))
                    return "type: string expected";
            if (message.timestamp != null && message.hasOwnProperty("timestamp"))
                if (typeof message.timestamp !== "number")
                    return "timestamp: number expected";
            if (message.legId != null && message.hasOwnProperty("legId"))
                if (!$util.isString(message.legId))
                    return "legId: string expected";
            if (message.statusCode != null && message.hasOwnProperty("statusCode")) {
                properties._statusCode = 1;
                if (!$util.isInteger(message.statusCode))
                    return "statusCode: integer expected";
            }
            if (message.reason != null && message.hasOwnProperty("reason")) {
                properties._reason = 1;
                if (!$util.isString(message.reason))
                    return "reason: string expected";
            }
            return null;
        };

        /**
         * Creates a CdrEvent message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.CdrEvent
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.CdrEvent} CdrEvent
         */
        CdrEvent.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.CdrEvent)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.CdrEvent();
            if (object.type != null)
                if (typeof object.type !== "string" || object.type.length)
                    message.type = String(object.type);
            if (object.timestamp != null)
                if (Number(object.timestamp) !== 0)
                    message.timestamp = Number(object.timestamp);
            if (object.legId != null)
                if (typeof object.legId !== "string" || object.legId.length)
                    message.legId = String(object.legId);
            if (object.statusCode != null)
                message.statusCode = object.statusCode | 0;
            if (object.reason != null)
                message.reason = String(object.reason);
            return message;
        };

        /**
         * Creates a plain object from a CdrEvent message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.CdrEvent
         * @static
         * @param {bench.CdrEvent} message CdrEvent
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        CdrEvent.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.defaults) {
                object.type = "";
                object.timestamp = 0;
                object.legId = "";
            }
            if (message.type != null && message.hasOwnProperty("type"))
                object.type = message.type;
            if (message.timestamp != null && message.hasOwnProperty("timestamp"))
                object.timestamp = options.json && !isFinite(message.timestamp) ? String(message.timestamp) : message.timestamp;
            if (message.legId != null && message.hasOwnProperty("legId"))
                object.legId = message.legId;
            if (message.statusCode != null && message.hasOwnProperty("statusCode"))
                object.statusCode = message.statusCode;
            if (message.reason != null && message.hasOwnProperty("reason"))
                object.reason = message.reason;
            return object;
        };

        /**
         * Converts this CdrEvent to JSON.
         * @function toJSON
         * @memberof bench.CdrEvent
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        CdrEvent.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for CdrEvent
         * @function getTypeUrl
         * @memberof bench.CdrEvent
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        CdrEvent.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.CdrEvent";
        };

        return CdrEvent;
    })();

    bench.CallTopology = (function() {

        /**
         * Properties of a CallTopology.
         * @typedef {Object} bench.CallTopology.$Properties
         * @property {string|null} [pri] CallTopology pri
         * @property {string|null} [bak] CallTopology bak
         * @property {number|null} [gen] CallTopology gen
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a CallTopology.
         * @memberof bench
         * @interface ICallTopology
         * @augments bench.CallTopology.$Properties
         * @deprecated Use bench.CallTopology.$Properties instead.
         */

        /**
         * Shape of a CallTopology.
         * @typedef {bench.CallTopology.$Properties} bench.CallTopology.$Shape
         */

        /**
         * Constructs a new CallTopology.
         * @memberof bench
         * @classdesc Represents a CallTopology.
         * @constructor
         * @param {bench.CallTopology.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function CallTopology(properties) {
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * CallTopology pri.
         * @member {string} pri
         * @memberof bench.CallTopology
         * @instance
         */
        CallTopology.prototype.pri = "";

        /**
         * CallTopology bak.
         * @member {string} bak
         * @memberof bench.CallTopology
         * @instance
         */
        CallTopology.prototype.bak = "";

        /**
         * CallTopology gen.
         * @member {number} gen
         * @memberof bench.CallTopology
         * @instance
         */
        CallTopology.prototype.gen = 0;

        /**
         * Creates a new CallTopology instance using the specified properties.
         * @function create
         * @memberof bench.CallTopology
         * @static
         * @param {bench.CallTopology.$Properties=} [properties] Properties to set
         * @returns {bench.CallTopology} CallTopology instance
         * @type {{
         *   (properties: bench.CallTopology.$Shape): bench.CallTopology & bench.CallTopology.$Shape;
         *   (properties?: bench.CallTopology.$Properties): bench.CallTopology;
         * }}
         */
        CallTopology.create = function create(properties) {
            return new CallTopology(properties);
        };

        /**
         * Encodes the specified CallTopology message. Does not implicitly {@link bench.CallTopology.verify|verify} messages.
         * @function encode
         * @memberof bench.CallTopology
         * @static
         * @param {bench.CallTopology.$Properties} message CallTopology message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CallTopology.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.pri != null && Object.hasOwnProperty.call(message, "pri"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.pri);
            if (message.bak != null && Object.hasOwnProperty.call(message, "bak"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.bak);
            if (message.gen != null && Object.hasOwnProperty.call(message, "gen"))
                writer.uint32(/* id 3, wireType 0 =*/24).int32(message.gen);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified CallTopology message, length delimited. Does not implicitly {@link bench.CallTopology.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.CallTopology
         * @static
         * @param {bench.CallTopology.$Properties} message CallTopology message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        CallTopology.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a CallTopology message from the specified reader or buffer.
         * @function decode
         * @memberof bench.CallTopology
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.CallTopology & bench.CallTopology.$Shape} CallTopology
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CallTopology.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.CallTopology(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.pri = value;
                        else
                            delete message.pri;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.bak = value;
                        else
                            delete message.bak;
                        continue;
                    }
                case 3: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.int32())
                            message.gen = value;
                        else
                            delete message.gen;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a CallTopology message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.CallTopology
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.CallTopology & bench.CallTopology.$Shape} CallTopology
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        CallTopology.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a CallTopology message.
         * @function verify
         * @memberof bench.CallTopology
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        CallTopology.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.pri != null && message.hasOwnProperty("pri"))
                if (!$util.isString(message.pri))
                    return "pri: string expected";
            if (message.bak != null && message.hasOwnProperty("bak"))
                if (!$util.isString(message.bak))
                    return "bak: string expected";
            if (message.gen != null && message.hasOwnProperty("gen"))
                if (!$util.isInteger(message.gen))
                    return "gen: integer expected";
            return null;
        };

        /**
         * Creates a CallTopology message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.CallTopology
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.CallTopology} CallTopology
         */
        CallTopology.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.CallTopology)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.CallTopology();
            if (object.pri != null)
                if (typeof object.pri !== "string" || object.pri.length)
                    message.pri = String(object.pri);
            if (object.bak != null)
                if (typeof object.bak !== "string" || object.bak.length)
                    message.bak = String(object.bak);
            if (object.gen != null)
                if (Number(object.gen) !== 0)
                    message.gen = object.gen | 0;
            return message;
        };

        /**
         * Creates a plain object from a CallTopology message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.CallTopology
         * @static
         * @param {bench.CallTopology} message CallTopology
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        CallTopology.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.defaults) {
                object.pri = "";
                object.bak = "";
                object.gen = 0;
            }
            if (message.pri != null && message.hasOwnProperty("pri"))
                object.pri = message.pri;
            if (message.bak != null && message.hasOwnProperty("bak"))
                object.bak = message.bak;
            if (message.gen != null && message.hasOwnProperty("gen"))
                object.gen = message.gen;
            return object;
        };

        /**
         * Converts this CallTopology to JSON.
         * @function toJSON
         * @memberof bench.CallTopology
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        CallTopology.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for CallTopology
         * @function getTypeUrl
         * @memberof bench.CallTopology
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        CallTopology.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.CallTopology";
        };

        return CallTopology;
    })();

    bench.ActiveRule = (function() {

        /**
         * Properties of an ActiveRule.
         * @typedef {Object} bench.ActiveRule.$Properties
         * @property {string|null} [id] ActiveRule id
         * @property {string|null} [paramsJson] ActiveRule paramsJson
         * @property {boolean|null} [active] ActiveRule active
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of an ActiveRule.
         * @memberof bench
         * @interface IActiveRule
         * @augments bench.ActiveRule.$Properties
         * @deprecated Use bench.ActiveRule.$Properties instead.
         */

        /**
         * Shape of an ActiveRule.
         * @typedef {bench.ActiveRule.$Properties} bench.ActiveRule.$Shape
         */

        /**
         * Constructs a new ActiveRule.
         * @memberof bench
         * @classdesc Represents an ActiveRule.
         * @constructor
         * @param {bench.ActiveRule.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function ActiveRule(properties) {
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * ActiveRule id.
         * @member {string} id
         * @memberof bench.ActiveRule
         * @instance
         */
        ActiveRule.prototype.id = "";

        /**
         * ActiveRule paramsJson.
         * @member {string|null|undefined} paramsJson
         * @memberof bench.ActiveRule
         * @instance
         */
        ActiveRule.prototype.paramsJson = null;

        /**
         * ActiveRule active.
         * @member {boolean} active
         * @memberof bench.ActiveRule
         * @instance
         */
        ActiveRule.prototype.active = false;

        // OneOf field names bound to virtual getters and setters
        var $oneOfFields;

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(ActiveRule.prototype, "_paramsJson", {
            get: $util.oneOfGetter($oneOfFields = ["paramsJson"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new ActiveRule instance using the specified properties.
         * @function create
         * @memberof bench.ActiveRule
         * @static
         * @param {bench.ActiveRule.$Properties=} [properties] Properties to set
         * @returns {bench.ActiveRule} ActiveRule instance
         * @type {{
         *   (properties: bench.ActiveRule.$Shape): bench.ActiveRule & bench.ActiveRule.$Shape;
         *   (properties?: bench.ActiveRule.$Properties): bench.ActiveRule;
         * }}
         */
        ActiveRule.create = function create(properties) {
            return new ActiveRule(properties);
        };

        /**
         * Encodes the specified ActiveRule message. Does not implicitly {@link bench.ActiveRule.verify|verify} messages.
         * @function encode
         * @memberof bench.ActiveRule
         * @static
         * @param {bench.ActiveRule.$Properties} message ActiveRule message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ActiveRule.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.id);
            if (message.paramsJson != null && Object.hasOwnProperty.call(message, "paramsJson"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.paramsJson);
            if (message.active != null && Object.hasOwnProperty.call(message, "active"))
                writer.uint32(/* id 3, wireType 0 =*/24).bool(message.active);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified ActiveRule message, length delimited. Does not implicitly {@link bench.ActiveRule.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.ActiveRule
         * @static
         * @param {bench.ActiveRule.$Properties} message ActiveRule message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ActiveRule.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes an ActiveRule message from the specified reader or buffer.
         * @function decode
         * @memberof bench.ActiveRule
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.ActiveRule & bench.ActiveRule.$Shape} ActiveRule
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ActiveRule.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.ActiveRule(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.id = value;
                        else
                            delete message.id;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        message.paramsJson = reader.string();
                        message._paramsJson = "paramsJson";
                        continue;
                    }
                case 3: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.bool())
                            message.active = value;
                        else
                            delete message.active;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes an ActiveRule message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.ActiveRule
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.ActiveRule & bench.ActiveRule.$Shape} ActiveRule
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ActiveRule.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies an ActiveRule message.
         * @function verify
         * @memberof bench.ActiveRule
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        ActiveRule.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            var properties = {};
            if (message.id != null && message.hasOwnProperty("id"))
                if (!$util.isString(message.id))
                    return "id: string expected";
            if (message.paramsJson != null && message.hasOwnProperty("paramsJson")) {
                properties._paramsJson = 1;
                if (!$util.isString(message.paramsJson))
                    return "paramsJson: string expected";
            }
            if (message.active != null && message.hasOwnProperty("active"))
                if (typeof message.active !== "boolean")
                    return "active: boolean expected";
            return null;
        };

        /**
         * Creates an ActiveRule message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.ActiveRule
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.ActiveRule} ActiveRule
         */
        ActiveRule.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.ActiveRule)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.ActiveRule();
            if (object.id != null)
                if (typeof object.id !== "string" || object.id.length)
                    message.id = String(object.id);
            if (object.paramsJson != null)
                message.paramsJson = String(object.paramsJson);
            if (object.active != null)
                if (object.active)
                    message.active = Boolean(object.active);
            return message;
        };

        /**
         * Creates a plain object from an ActiveRule message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.ActiveRule
         * @static
         * @param {bench.ActiveRule} message ActiveRule
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        ActiveRule.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.defaults) {
                object.id = "";
                object.active = false;
            }
            if (message.id != null && message.hasOwnProperty("id"))
                object.id = message.id;
            if (message.paramsJson != null && message.hasOwnProperty("paramsJson"))
                object.paramsJson = message.paramsJson;
            if (message.active != null && message.hasOwnProperty("active"))
                object.active = message.active;
            return object;
        };

        /**
         * Converts this ActiveRule to JSON.
         * @function toJSON
         * @memberof bench.ActiveRule
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        ActiveRule.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for ActiveRule
         * @function getTypeUrl
         * @memberof bench.ActiveRule
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        ActiveRule.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.ActiveRule";
        };

        return ActiveRule;
    })();

    bench.RuleStateEntry = (function() {

        /**
         * Properties of a RuleStateEntry.
         * @typedef {Object} bench.RuleStateEntry.$Properties
         * @property {string|null} [ruleId] RuleStateEntry ruleId
         * @property {string|null} [stateJson] RuleStateEntry stateJson
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a RuleStateEntry.
         * @memberof bench
         * @interface IRuleStateEntry
         * @augments bench.RuleStateEntry.$Properties
         * @deprecated Use bench.RuleStateEntry.$Properties instead.
         */

        /**
         * Shape of a RuleStateEntry.
         * @typedef {bench.RuleStateEntry.$Properties} bench.RuleStateEntry.$Shape
         */

        /**
         * Constructs a new RuleStateEntry.
         * @memberof bench
         * @classdesc Represents a RuleStateEntry.
         * @constructor
         * @param {bench.RuleStateEntry.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function RuleStateEntry(properties) {
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * RuleStateEntry ruleId.
         * @member {string} ruleId
         * @memberof bench.RuleStateEntry
         * @instance
         */
        RuleStateEntry.prototype.ruleId = "";

        /**
         * RuleStateEntry stateJson.
         * @member {string|null|undefined} stateJson
         * @memberof bench.RuleStateEntry
         * @instance
         */
        RuleStateEntry.prototype.stateJson = null;

        // OneOf field names bound to virtual getters and setters
        var $oneOfFields;

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(RuleStateEntry.prototype, "_stateJson", {
            get: $util.oneOfGetter($oneOfFields = ["stateJson"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new RuleStateEntry instance using the specified properties.
         * @function create
         * @memberof bench.RuleStateEntry
         * @static
         * @param {bench.RuleStateEntry.$Properties=} [properties] Properties to set
         * @returns {bench.RuleStateEntry} RuleStateEntry instance
         * @type {{
         *   (properties: bench.RuleStateEntry.$Shape): bench.RuleStateEntry & bench.RuleStateEntry.$Shape;
         *   (properties?: bench.RuleStateEntry.$Properties): bench.RuleStateEntry;
         * }}
         */
        RuleStateEntry.create = function create(properties) {
            return new RuleStateEntry(properties);
        };

        /**
         * Encodes the specified RuleStateEntry message. Does not implicitly {@link bench.RuleStateEntry.verify|verify} messages.
         * @function encode
         * @memberof bench.RuleStateEntry
         * @static
         * @param {bench.RuleStateEntry.$Properties} message RuleStateEntry message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        RuleStateEntry.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.ruleId != null && Object.hasOwnProperty.call(message, "ruleId"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.ruleId);
            if (message.stateJson != null && Object.hasOwnProperty.call(message, "stateJson"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.stateJson);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified RuleStateEntry message, length delimited. Does not implicitly {@link bench.RuleStateEntry.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.RuleStateEntry
         * @static
         * @param {bench.RuleStateEntry.$Properties} message RuleStateEntry message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        RuleStateEntry.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a RuleStateEntry message from the specified reader or buffer.
         * @function decode
         * @memberof bench.RuleStateEntry
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.RuleStateEntry & bench.RuleStateEntry.$Shape} RuleStateEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        RuleStateEntry.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.RuleStateEntry(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.ruleId = value;
                        else
                            delete message.ruleId;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        message.stateJson = reader.string();
                        message._stateJson = "stateJson";
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a RuleStateEntry message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.RuleStateEntry
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.RuleStateEntry & bench.RuleStateEntry.$Shape} RuleStateEntry
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        RuleStateEntry.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a RuleStateEntry message.
         * @function verify
         * @memberof bench.RuleStateEntry
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        RuleStateEntry.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            var properties = {};
            if (message.ruleId != null && message.hasOwnProperty("ruleId"))
                if (!$util.isString(message.ruleId))
                    return "ruleId: string expected";
            if (message.stateJson != null && message.hasOwnProperty("stateJson")) {
                properties._stateJson = 1;
                if (!$util.isString(message.stateJson))
                    return "stateJson: string expected";
            }
            return null;
        };

        /**
         * Creates a RuleStateEntry message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.RuleStateEntry
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.RuleStateEntry} RuleStateEntry
         */
        RuleStateEntry.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.RuleStateEntry)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.RuleStateEntry();
            if (object.ruleId != null)
                if (typeof object.ruleId !== "string" || object.ruleId.length)
                    message.ruleId = String(object.ruleId);
            if (object.stateJson != null)
                message.stateJson = String(object.stateJson);
            return message;
        };

        /**
         * Creates a plain object from a RuleStateEntry message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.RuleStateEntry
         * @static
         * @param {bench.RuleStateEntry} message RuleStateEntry
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        RuleStateEntry.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.defaults)
                object.ruleId = "";
            if (message.ruleId != null && message.hasOwnProperty("ruleId"))
                object.ruleId = message.ruleId;
            if (message.stateJson != null && message.hasOwnProperty("stateJson"))
                object.stateJson = message.stateJson;
            return object;
        };

        /**
         * Converts this RuleStateEntry to JSON.
         * @function toJSON
         * @memberof bench.RuleStateEntry
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        RuleStateEntry.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for RuleStateEntry
         * @function getTypeUrl
         * @memberof bench.RuleStateEntry
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        RuleStateEntry.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.RuleStateEntry";
        };

        return RuleStateEntry;
    })();

    bench.ActivePeer = (function() {

        /**
         * Properties of an ActivePeer.
         * @typedef {Object} bench.ActivePeer.$Properties
         * @property {string|null} [legA] ActivePeer legA
         * @property {string|null} [legB] ActivePeer legB
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of an ActivePeer.
         * @memberof bench
         * @interface IActivePeer
         * @augments bench.ActivePeer.$Properties
         * @deprecated Use bench.ActivePeer.$Properties instead.
         */

        /**
         * Shape of an ActivePeer.
         * @typedef {bench.ActivePeer.$Properties} bench.ActivePeer.$Shape
         */

        /**
         * Constructs a new ActivePeer.
         * @memberof bench
         * @classdesc Represents an ActivePeer.
         * @constructor
         * @param {bench.ActivePeer.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function ActivePeer(properties) {
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * ActivePeer legA.
         * @member {string} legA
         * @memberof bench.ActivePeer
         * @instance
         */
        ActivePeer.prototype.legA = "";

        /**
         * ActivePeer legB.
         * @member {string} legB
         * @memberof bench.ActivePeer
         * @instance
         */
        ActivePeer.prototype.legB = "";

        /**
         * Creates a new ActivePeer instance using the specified properties.
         * @function create
         * @memberof bench.ActivePeer
         * @static
         * @param {bench.ActivePeer.$Properties=} [properties] Properties to set
         * @returns {bench.ActivePeer} ActivePeer instance
         * @type {{
         *   (properties: bench.ActivePeer.$Shape): bench.ActivePeer & bench.ActivePeer.$Shape;
         *   (properties?: bench.ActivePeer.$Properties): bench.ActivePeer;
         * }}
         */
        ActivePeer.create = function create(properties) {
            return new ActivePeer(properties);
        };

        /**
         * Encodes the specified ActivePeer message. Does not implicitly {@link bench.ActivePeer.verify|verify} messages.
         * @function encode
         * @memberof bench.ActivePeer
         * @static
         * @param {bench.ActivePeer.$Properties} message ActivePeer message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ActivePeer.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.legA != null && Object.hasOwnProperty.call(message, "legA"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.legA);
            if (message.legB != null && Object.hasOwnProperty.call(message, "legB"))
                writer.uint32(/* id 2, wireType 2 =*/18).string(message.legB);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified ActivePeer message, length delimited. Does not implicitly {@link bench.ActivePeer.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.ActivePeer
         * @static
         * @param {bench.ActivePeer.$Properties} message ActivePeer message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        ActivePeer.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes an ActivePeer message from the specified reader or buffer.
         * @function decode
         * @memberof bench.ActivePeer
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.ActivePeer & bench.ActivePeer.$Shape} ActivePeer
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ActivePeer.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.ActivePeer(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.legA = value;
                        else
                            delete message.legA;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.legB = value;
                        else
                            delete message.legB;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes an ActivePeer message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.ActivePeer
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.ActivePeer & bench.ActivePeer.$Shape} ActivePeer
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        ActivePeer.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies an ActivePeer message.
         * @function verify
         * @memberof bench.ActivePeer
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        ActivePeer.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.legA != null && message.hasOwnProperty("legA"))
                if (!$util.isString(message.legA))
                    return "legA: string expected";
            if (message.legB != null && message.hasOwnProperty("legB"))
                if (!$util.isString(message.legB))
                    return "legB: string expected";
            return null;
        };

        /**
         * Creates an ActivePeer message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.ActivePeer
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.ActivePeer} ActivePeer
         */
        ActivePeer.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.ActivePeer)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.ActivePeer();
            if (object.legA != null)
                if (typeof object.legA !== "string" || object.legA.length)
                    message.legA = String(object.legA);
            if (object.legB != null)
                if (typeof object.legB !== "string" || object.legB.length)
                    message.legB = String(object.legB);
            return message;
        };

        /**
         * Creates a plain object from an ActivePeer message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.ActivePeer
         * @static
         * @param {bench.ActivePeer} message ActivePeer
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        ActivePeer.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.defaults) {
                object.legA = "";
                object.legB = "";
            }
            if (message.legA != null && message.hasOwnProperty("legA"))
                object.legA = message.legA;
            if (message.legB != null && message.hasOwnProperty("legB"))
                object.legB = message.legB;
            return object;
        };

        /**
         * Converts this ActivePeer to JSON.
         * @function toJSON
         * @memberof bench.ActivePeer
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        ActivePeer.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for ActivePeer
         * @function getTypeUrl
         * @memberof bench.ActivePeer
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        ActivePeer.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.ActivePeer";
        };

        return ActivePeer;
    })();

    bench.Call = (function() {

        /**
         * Properties of a Call.
         * @typedef {Object} bench.Call.$Properties
         * @property {string|null} [callRef] Call callRef
         * @property {bench.Leg.$Properties|null} [aLeg] Call aLeg
         * @property {Array.<bench.Leg.$Properties>|null} [bLegs] Call bLegs
         * @property {bench.ActivePeer.$Properties|null} [activePeer] Call activePeer
         * @property {string|null} [callbackContext] Call callbackContext
         * @property {string|null} [billingContext] Call billingContext
         * @property {bench.ALegInvite.$Properties|null} [aLegInvite] Call aLegInvite
         * @property {Array.<bench.CallLimiterState.$Properties>|null} [limiterEntries] Call limiterEntries
         * @property {Array.<bench.TimerEntry.$Properties>|null} [timers] Call timers
         * @property {Array.<bench.CdrEvent.$Properties>|null} [cdrEvents] Call cdrEvents
         * @property {string|null} [state] Call state
         * @property {number|null} [createdAt] Call createdAt
         * @property {Array.<string>|null} [aLegPendingVias] Call aLegPendingVias
         * @property {number|null} [aLegPendingCSeq] Call aLegPendingCSeq
         * @property {Array.<bench.TagMapping.$Properties>|null} [tagMap] Call tagMap
         * @property {string|null} [traceId] Call traceId
         * @property {string|null} [rootSpanId] Call rootSpanId
         * @property {boolean|null} [sampled] Call sampled
         * @property {number|null} [workerIndex] Call workerIndex
         * @property {bench.CallTopology.$Properties|null} [topology] Call topology
         * @property {boolean|null} [emergency] Call emergency
         * @property {string|null} [featuresJson] Call featuresJson
         * @property {string|null} [policyUpdateHeadersJson] Call policyUpdateHeadersJson
         * @property {Uint8Array|null} [policyUpdateBody] Call policyUpdateBody
         * @property {Array.<bench.ActiveRule.$Properties>|null} [activeRules] Call activeRules
         * @property {Array.<bench.RuleStateEntry.$Properties>|null} [ruleState] Call ruleState
         * @property {string|null} [transferJson] Call transferJson
         * @property {string|null} [earlyPromoteJson] Call earlyPromoteJson
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a Call.
         * @memberof bench
         * @interface ICall
         * @augments bench.Call.$Properties
         * @deprecated Use bench.Call.$Properties instead.
         */

        /**
         * Shape of a Call.
         * @typedef {bench.Call.$Properties} bench.Call.$Shape
         */

        /**
         * Constructs a new Call.
         * @memberof bench
         * @classdesc Represents a Call.
         * @constructor
         * @param {bench.Call.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function Call(properties) {
            this.bLegs = [];
            this.limiterEntries = [];
            this.timers = [];
            this.cdrEvents = [];
            this.aLegPendingVias = [];
            this.tagMap = [];
            this.activeRules = [];
            this.ruleState = [];
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * Call callRef.
         * @member {string} callRef
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.callRef = "";

        /**
         * Call aLeg.
         * @member {bench.Leg.$Properties|null|undefined} aLeg
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.aLeg = null;

        /**
         * Call bLegs.
         * @member {Array.<bench.Leg.$Properties>} bLegs
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.bLegs = $util.emptyArray;

        /**
         * Call activePeer.
         * @member {bench.ActivePeer.$Properties|null|undefined} activePeer
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.activePeer = null;

        /**
         * Call callbackContext.
         * @member {string|null|undefined} callbackContext
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.callbackContext = null;

        /**
         * Call billingContext.
         * @member {string|null|undefined} billingContext
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.billingContext = null;

        /**
         * Call aLegInvite.
         * @member {bench.ALegInvite.$Properties|null|undefined} aLegInvite
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.aLegInvite = null;

        /**
         * Call limiterEntries.
         * @member {Array.<bench.CallLimiterState.$Properties>} limiterEntries
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.limiterEntries = $util.emptyArray;

        /**
         * Call timers.
         * @member {Array.<bench.TimerEntry.$Properties>} timers
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.timers = $util.emptyArray;

        /**
         * Call cdrEvents.
         * @member {Array.<bench.CdrEvent.$Properties>} cdrEvents
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.cdrEvents = $util.emptyArray;

        /**
         * Call state.
         * @member {string} state
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.state = "";

        /**
         * Call createdAt.
         * @member {number} createdAt
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.createdAt = 0;

        /**
         * Call aLegPendingVias.
         * @member {Array.<string>} aLegPendingVias
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.aLegPendingVias = $util.emptyArray;

        /**
         * Call aLegPendingCSeq.
         * @member {number|null|undefined} aLegPendingCSeq
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.aLegPendingCSeq = null;

        /**
         * Call tagMap.
         * @member {Array.<bench.TagMapping.$Properties>} tagMap
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.tagMap = $util.emptyArray;

        /**
         * Call traceId.
         * @member {string|null|undefined} traceId
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.traceId = null;

        /**
         * Call rootSpanId.
         * @member {string|null|undefined} rootSpanId
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.rootSpanId = null;

        /**
         * Call sampled.
         * @member {boolean|null|undefined} sampled
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.sampled = null;

        /**
         * Call workerIndex.
         * @member {number|null|undefined} workerIndex
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.workerIndex = null;

        /**
         * Call topology.
         * @member {bench.CallTopology.$Properties|null|undefined} topology
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.topology = null;

        /**
         * Call emergency.
         * @member {boolean|null|undefined} emergency
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.emergency = null;

        /**
         * Call featuresJson.
         * @member {string|null|undefined} featuresJson
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.featuresJson = null;

        /**
         * Call policyUpdateHeadersJson.
         * @member {string|null|undefined} policyUpdateHeadersJson
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.policyUpdateHeadersJson = null;

        /**
         * Call policyUpdateBody.
         * @member {Uint8Array|null|undefined} policyUpdateBody
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.policyUpdateBody = null;

        /**
         * Call activeRules.
         * @member {Array.<bench.ActiveRule.$Properties>} activeRules
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.activeRules = $util.emptyArray;

        /**
         * Call ruleState.
         * @member {Array.<bench.RuleStateEntry.$Properties>} ruleState
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.ruleState = $util.emptyArray;

        /**
         * Call transferJson.
         * @member {string|null|undefined} transferJson
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.transferJson = null;

        /**
         * Call earlyPromoteJson.
         * @member {string|null|undefined} earlyPromoteJson
         * @memberof bench.Call
         * @instance
         */
        Call.prototype.earlyPromoteJson = null;

        // OneOf field names bound to virtual getters and setters
        var $oneOfFields;

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_activePeer", {
            get: $util.oneOfGetter($oneOfFields = ["activePeer"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_callbackContext", {
            get: $util.oneOfGetter($oneOfFields = ["callbackContext"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_billingContext", {
            get: $util.oneOfGetter($oneOfFields = ["billingContext"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_aLegPendingCSeq", {
            get: $util.oneOfGetter($oneOfFields = ["aLegPendingCSeq"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_traceId", {
            get: $util.oneOfGetter($oneOfFields = ["traceId"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_rootSpanId", {
            get: $util.oneOfGetter($oneOfFields = ["rootSpanId"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_sampled", {
            get: $util.oneOfGetter($oneOfFields = ["sampled"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_workerIndex", {
            get: $util.oneOfGetter($oneOfFields = ["workerIndex"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_topology", {
            get: $util.oneOfGetter($oneOfFields = ["topology"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_emergency", {
            get: $util.oneOfGetter($oneOfFields = ["emergency"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_featuresJson", {
            get: $util.oneOfGetter($oneOfFields = ["featuresJson"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_policyUpdateHeadersJson", {
            get: $util.oneOfGetter($oneOfFields = ["policyUpdateHeadersJson"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_policyUpdateBody", {
            get: $util.oneOfGetter($oneOfFields = ["policyUpdateBody"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_transferJson", {
            get: $util.oneOfGetter($oneOfFields = ["transferJson"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        // Virtual OneOf for proto3 optional field
        Object.defineProperty(Call.prototype, "_earlyPromoteJson", {
            get: $util.oneOfGetter($oneOfFields = ["earlyPromoteJson"]),
            set: $util.oneOfSetter($oneOfFields)
        });

        /**
         * Creates a new Call instance using the specified properties.
         * @function create
         * @memberof bench.Call
         * @static
         * @param {bench.Call.$Properties=} [properties] Properties to set
         * @returns {bench.Call} Call instance
         * @type {{
         *   (properties: bench.Call.$Shape): bench.Call & bench.Call.$Shape;
         *   (properties?: bench.Call.$Properties): bench.Call;
         * }}
         */
        Call.create = function create(properties) {
            return new Call(properties);
        };

        /**
         * Encodes the specified Call message. Does not implicitly {@link bench.Call.verify|verify} messages.
         * @function encode
         * @memberof bench.Call
         * @static
         * @param {bench.Call.$Properties} message Call message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Call.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.callRef != null && Object.hasOwnProperty.call(message, "callRef"))
                writer.uint32(/* id 1, wireType 2 =*/10).string(message.callRef);
            if (message.aLeg != null && Object.hasOwnProperty.call(message, "aLeg"))
                $root.bench.Leg.encode(message.aLeg, writer.uint32(/* id 2, wireType 2 =*/18).fork(), _depth + 1).ldelim();
            if (message.bLegs != null && message.bLegs.length)
                for (var i = 0; i < message.bLegs.length; ++i)
                    $root.bench.Leg.encode(message.bLegs[i], writer.uint32(/* id 3, wireType 2 =*/26).fork(), _depth + 1).ldelim();
            if (message.activePeer != null && Object.hasOwnProperty.call(message, "activePeer"))
                $root.bench.ActivePeer.encode(message.activePeer, writer.uint32(/* id 4, wireType 2 =*/34).fork(), _depth + 1).ldelim();
            if (message.callbackContext != null && Object.hasOwnProperty.call(message, "callbackContext"))
                writer.uint32(/* id 5, wireType 2 =*/42).string(message.callbackContext);
            if (message.billingContext != null && Object.hasOwnProperty.call(message, "billingContext"))
                writer.uint32(/* id 6, wireType 2 =*/50).string(message.billingContext);
            if (message.aLegInvite != null && Object.hasOwnProperty.call(message, "aLegInvite"))
                $root.bench.ALegInvite.encode(message.aLegInvite, writer.uint32(/* id 7, wireType 2 =*/58).fork(), _depth + 1).ldelim();
            if (message.limiterEntries != null && message.limiterEntries.length)
                for (var i = 0; i < message.limiterEntries.length; ++i)
                    $root.bench.CallLimiterState.encode(message.limiterEntries[i], writer.uint32(/* id 8, wireType 2 =*/66).fork(), _depth + 1).ldelim();
            if (message.timers != null && message.timers.length)
                for (var i = 0; i < message.timers.length; ++i)
                    $root.bench.TimerEntry.encode(message.timers[i], writer.uint32(/* id 9, wireType 2 =*/74).fork(), _depth + 1).ldelim();
            if (message.cdrEvents != null && message.cdrEvents.length)
                for (var i = 0; i < message.cdrEvents.length; ++i)
                    $root.bench.CdrEvent.encode(message.cdrEvents[i], writer.uint32(/* id 10, wireType 2 =*/82).fork(), _depth + 1).ldelim();
            if (message.state != null && Object.hasOwnProperty.call(message, "state"))
                writer.uint32(/* id 11, wireType 2 =*/90).string(message.state);
            if (message.createdAt != null && Object.hasOwnProperty.call(message, "createdAt"))
                writer.uint32(/* id 12, wireType 1 =*/97).double(message.createdAt);
            if (message.aLegPendingVias != null && message.aLegPendingVias.length)
                for (var i = 0; i < message.aLegPendingVias.length; ++i)
                    writer.uint32(/* id 13, wireType 2 =*/106).string(message.aLegPendingVias[i]);
            if (message.aLegPendingCSeq != null && Object.hasOwnProperty.call(message, "aLegPendingCSeq"))
                writer.uint32(/* id 14, wireType 0 =*/112).int32(message.aLegPendingCSeq);
            if (message.tagMap != null && message.tagMap.length)
                for (var i = 0; i < message.tagMap.length; ++i)
                    $root.bench.TagMapping.encode(message.tagMap[i], writer.uint32(/* id 15, wireType 2 =*/122).fork(), _depth + 1).ldelim();
            if (message.traceId != null && Object.hasOwnProperty.call(message, "traceId"))
                writer.uint32(/* id 16, wireType 2 =*/130).string(message.traceId);
            if (message.rootSpanId != null && Object.hasOwnProperty.call(message, "rootSpanId"))
                writer.uint32(/* id 17, wireType 2 =*/138).string(message.rootSpanId);
            if (message.sampled != null && Object.hasOwnProperty.call(message, "sampled"))
                writer.uint32(/* id 18, wireType 0 =*/144).bool(message.sampled);
            if (message.workerIndex != null && Object.hasOwnProperty.call(message, "workerIndex"))
                writer.uint32(/* id 19, wireType 0 =*/152).int32(message.workerIndex);
            if (message.topology != null && Object.hasOwnProperty.call(message, "topology"))
                $root.bench.CallTopology.encode(message.topology, writer.uint32(/* id 20, wireType 2 =*/162).fork(), _depth + 1).ldelim();
            if (message.emergency != null && Object.hasOwnProperty.call(message, "emergency"))
                writer.uint32(/* id 21, wireType 0 =*/168).bool(message.emergency);
            if (message.featuresJson != null && Object.hasOwnProperty.call(message, "featuresJson"))
                writer.uint32(/* id 22, wireType 2 =*/178).string(message.featuresJson);
            if (message.policyUpdateHeadersJson != null && Object.hasOwnProperty.call(message, "policyUpdateHeadersJson"))
                writer.uint32(/* id 23, wireType 2 =*/186).string(message.policyUpdateHeadersJson);
            if (message.policyUpdateBody != null && Object.hasOwnProperty.call(message, "policyUpdateBody"))
                writer.uint32(/* id 24, wireType 2 =*/194).bytes(message.policyUpdateBody);
            if (message.activeRules != null && message.activeRules.length)
                for (var i = 0; i < message.activeRules.length; ++i)
                    $root.bench.ActiveRule.encode(message.activeRules[i], writer.uint32(/* id 25, wireType 2 =*/202).fork(), _depth + 1).ldelim();
            if (message.ruleState != null && message.ruleState.length)
                for (var i = 0; i < message.ruleState.length; ++i)
                    $root.bench.RuleStateEntry.encode(message.ruleState[i], writer.uint32(/* id 26, wireType 2 =*/210).fork(), _depth + 1).ldelim();
            if (message.transferJson != null && Object.hasOwnProperty.call(message, "transferJson"))
                writer.uint32(/* id 27, wireType 2 =*/218).string(message.transferJson);
            if (message.earlyPromoteJson != null && Object.hasOwnProperty.call(message, "earlyPromoteJson"))
                writer.uint32(/* id 28, wireType 2 =*/226).string(message.earlyPromoteJson);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified Call message, length delimited. Does not implicitly {@link bench.Call.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.Call
         * @static
         * @param {bench.Call.$Properties} message Call message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Call.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a Call message from the specified reader or buffer.
         * @function decode
         * @memberof bench.Call
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.Call & bench.Call.$Shape} Call
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Call.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.Call(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.callRef = value;
                        else
                            delete message.callRef;
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        message.aLeg = $root.bench.Leg.decode(reader, reader.uint32(), undefined, _depth + 1, message.aLeg);
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if (!(message.bLegs && message.bLegs.length))
                            message.bLegs = [];
                        message.bLegs.push($root.bench.Leg.decode(reader, reader.uint32(), undefined, _depth + 1));
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        message.activePeer = $root.bench.ActivePeer.decode(reader, reader.uint32(), undefined, _depth + 1, message.activePeer);
                        message._activePeer = "activePeer";
                        continue;
                    }
                case 5: {
                        if (wireType !== 2)
                            break;
                        message.callbackContext = reader.string();
                        message._callbackContext = "callbackContext";
                        continue;
                    }
                case 6: {
                        if (wireType !== 2)
                            break;
                        message.billingContext = reader.string();
                        message._billingContext = "billingContext";
                        continue;
                    }
                case 7: {
                        if (wireType !== 2)
                            break;
                        message.aLegInvite = $root.bench.ALegInvite.decode(reader, reader.uint32(), undefined, _depth + 1, message.aLegInvite);
                        continue;
                    }
                case 8: {
                        if (wireType !== 2)
                            break;
                        if (!(message.limiterEntries && message.limiterEntries.length))
                            message.limiterEntries = [];
                        message.limiterEntries.push($root.bench.CallLimiterState.decode(reader, reader.uint32(), undefined, _depth + 1));
                        continue;
                    }
                case 9: {
                        if (wireType !== 2)
                            break;
                        if (!(message.timers && message.timers.length))
                            message.timers = [];
                        message.timers.push($root.bench.TimerEntry.decode(reader, reader.uint32(), undefined, _depth + 1));
                        continue;
                    }
                case 10: {
                        if (wireType !== 2)
                            break;
                        if (!(message.cdrEvents && message.cdrEvents.length))
                            message.cdrEvents = [];
                        message.cdrEvents.push($root.bench.CdrEvent.decode(reader, reader.uint32(), undefined, _depth + 1));
                        continue;
                    }
                case 11: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.state = value;
                        else
                            delete message.state;
                        continue;
                    }
                case 12: {
                        if (wireType !== 1)
                            break;
                        if ((value = reader.double()) !== 0)
                            message.createdAt = value;
                        else
                            delete message.createdAt;
                        continue;
                    }
                case 13: {
                        if (wireType !== 2)
                            break;
                        if (!(message.aLegPendingVias && message.aLegPendingVias.length))
                            message.aLegPendingVias = [];
                        message.aLegPendingVias.push(reader.string());
                        continue;
                    }
                case 14: {
                        if (wireType !== 0)
                            break;
                        message.aLegPendingCSeq = reader.int32();
                        message._aLegPendingCSeq = "aLegPendingCSeq";
                        continue;
                    }
                case 15: {
                        if (wireType !== 2)
                            break;
                        if (!(message.tagMap && message.tagMap.length))
                            message.tagMap = [];
                        message.tagMap.push($root.bench.TagMapping.decode(reader, reader.uint32(), undefined, _depth + 1));
                        continue;
                    }
                case 16: {
                        if (wireType !== 2)
                            break;
                        message.traceId = reader.string();
                        message._traceId = "traceId";
                        continue;
                    }
                case 17: {
                        if (wireType !== 2)
                            break;
                        message.rootSpanId = reader.string();
                        message._rootSpanId = "rootSpanId";
                        continue;
                    }
                case 18: {
                        if (wireType !== 0)
                            break;
                        message.sampled = reader.bool();
                        message._sampled = "sampled";
                        continue;
                    }
                case 19: {
                        if (wireType !== 0)
                            break;
                        message.workerIndex = reader.int32();
                        message._workerIndex = "workerIndex";
                        continue;
                    }
                case 20: {
                        if (wireType !== 2)
                            break;
                        message.topology = $root.bench.CallTopology.decode(reader, reader.uint32(), undefined, _depth + 1, message.topology);
                        message._topology = "topology";
                        continue;
                    }
                case 21: {
                        if (wireType !== 0)
                            break;
                        message.emergency = reader.bool();
                        message._emergency = "emergency";
                        continue;
                    }
                case 22: {
                        if (wireType !== 2)
                            break;
                        message.featuresJson = reader.string();
                        message._featuresJson = "featuresJson";
                        continue;
                    }
                case 23: {
                        if (wireType !== 2)
                            break;
                        message.policyUpdateHeadersJson = reader.string();
                        message._policyUpdateHeadersJson = "policyUpdateHeadersJson";
                        continue;
                    }
                case 24: {
                        if (wireType !== 2)
                            break;
                        message.policyUpdateBody = reader.bytes();
                        message._policyUpdateBody = "policyUpdateBody";
                        continue;
                    }
                case 25: {
                        if (wireType !== 2)
                            break;
                        if (!(message.activeRules && message.activeRules.length))
                            message.activeRules = [];
                        message.activeRules.push($root.bench.ActiveRule.decode(reader, reader.uint32(), undefined, _depth + 1));
                        continue;
                    }
                case 26: {
                        if (wireType !== 2)
                            break;
                        if (!(message.ruleState && message.ruleState.length))
                            message.ruleState = [];
                        message.ruleState.push($root.bench.RuleStateEntry.decode(reader, reader.uint32(), undefined, _depth + 1));
                        continue;
                    }
                case 27: {
                        if (wireType !== 2)
                            break;
                        message.transferJson = reader.string();
                        message._transferJson = "transferJson";
                        continue;
                    }
                case 28: {
                        if (wireType !== 2)
                            break;
                        message.earlyPromoteJson = reader.string();
                        message._earlyPromoteJson = "earlyPromoteJson";
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a Call message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.Call
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.Call & bench.Call.$Shape} Call
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Call.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Call message.
         * @function verify
         * @memberof bench.Call
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Call.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            var properties = {};
            if (message.callRef != null && message.hasOwnProperty("callRef"))
                if (!$util.isString(message.callRef))
                    return "callRef: string expected";
            if (message.aLeg != null && message.hasOwnProperty("aLeg")) {
                var error = $root.bench.Leg.verify(message.aLeg, _depth + 1);
                if (error)
                    return "aLeg." + error;
            }
            if (message.bLegs != null && message.hasOwnProperty("bLegs")) {
                if (!Array.isArray(message.bLegs))
                    return "bLegs: array expected";
                for (var i = 0; i < message.bLegs.length; ++i) {
                    var error = $root.bench.Leg.verify(message.bLegs[i], _depth + 1);
                    if (error)
                        return "bLegs." + error;
                }
            }
            if (message.activePeer != null && message.hasOwnProperty("activePeer")) {
                properties._activePeer = 1;
                {
                    var error = $root.bench.ActivePeer.verify(message.activePeer, _depth + 1);
                    if (error)
                        return "activePeer." + error;
                }
            }
            if (message.callbackContext != null && message.hasOwnProperty("callbackContext")) {
                properties._callbackContext = 1;
                if (!$util.isString(message.callbackContext))
                    return "callbackContext: string expected";
            }
            if (message.billingContext != null && message.hasOwnProperty("billingContext")) {
                properties._billingContext = 1;
                if (!$util.isString(message.billingContext))
                    return "billingContext: string expected";
            }
            if (message.aLegInvite != null && message.hasOwnProperty("aLegInvite")) {
                var error = $root.bench.ALegInvite.verify(message.aLegInvite, _depth + 1);
                if (error)
                    return "aLegInvite." + error;
            }
            if (message.limiterEntries != null && message.hasOwnProperty("limiterEntries")) {
                if (!Array.isArray(message.limiterEntries))
                    return "limiterEntries: array expected";
                for (var i = 0; i < message.limiterEntries.length; ++i) {
                    var error = $root.bench.CallLimiterState.verify(message.limiterEntries[i], _depth + 1);
                    if (error)
                        return "limiterEntries." + error;
                }
            }
            if (message.timers != null && message.hasOwnProperty("timers")) {
                if (!Array.isArray(message.timers))
                    return "timers: array expected";
                for (var i = 0; i < message.timers.length; ++i) {
                    var error = $root.bench.TimerEntry.verify(message.timers[i], _depth + 1);
                    if (error)
                        return "timers." + error;
                }
            }
            if (message.cdrEvents != null && message.hasOwnProperty("cdrEvents")) {
                if (!Array.isArray(message.cdrEvents))
                    return "cdrEvents: array expected";
                for (var i = 0; i < message.cdrEvents.length; ++i) {
                    var error = $root.bench.CdrEvent.verify(message.cdrEvents[i], _depth + 1);
                    if (error)
                        return "cdrEvents." + error;
                }
            }
            if (message.state != null && message.hasOwnProperty("state"))
                if (!$util.isString(message.state))
                    return "state: string expected";
            if (message.createdAt != null && message.hasOwnProperty("createdAt"))
                if (typeof message.createdAt !== "number")
                    return "createdAt: number expected";
            if (message.aLegPendingVias != null && message.hasOwnProperty("aLegPendingVias")) {
                if (!Array.isArray(message.aLegPendingVias))
                    return "aLegPendingVias: array expected";
                for (var i = 0; i < message.aLegPendingVias.length; ++i)
                    if (!$util.isString(message.aLegPendingVias[i]))
                        return "aLegPendingVias: string[] expected";
            }
            if (message.aLegPendingCSeq != null && message.hasOwnProperty("aLegPendingCSeq")) {
                properties._aLegPendingCSeq = 1;
                if (!$util.isInteger(message.aLegPendingCSeq))
                    return "aLegPendingCSeq: integer expected";
            }
            if (message.tagMap != null && message.hasOwnProperty("tagMap")) {
                if (!Array.isArray(message.tagMap))
                    return "tagMap: array expected";
                for (var i = 0; i < message.tagMap.length; ++i) {
                    var error = $root.bench.TagMapping.verify(message.tagMap[i], _depth + 1);
                    if (error)
                        return "tagMap." + error;
                }
            }
            if (message.traceId != null && message.hasOwnProperty("traceId")) {
                properties._traceId = 1;
                if (!$util.isString(message.traceId))
                    return "traceId: string expected";
            }
            if (message.rootSpanId != null && message.hasOwnProperty("rootSpanId")) {
                properties._rootSpanId = 1;
                if (!$util.isString(message.rootSpanId))
                    return "rootSpanId: string expected";
            }
            if (message.sampled != null && message.hasOwnProperty("sampled")) {
                properties._sampled = 1;
                if (typeof message.sampled !== "boolean")
                    return "sampled: boolean expected";
            }
            if (message.workerIndex != null && message.hasOwnProperty("workerIndex")) {
                properties._workerIndex = 1;
                if (!$util.isInteger(message.workerIndex))
                    return "workerIndex: integer expected";
            }
            if (message.topology != null && message.hasOwnProperty("topology")) {
                properties._topology = 1;
                {
                    var error = $root.bench.CallTopology.verify(message.topology, _depth + 1);
                    if (error)
                        return "topology." + error;
                }
            }
            if (message.emergency != null && message.hasOwnProperty("emergency")) {
                properties._emergency = 1;
                if (typeof message.emergency !== "boolean")
                    return "emergency: boolean expected";
            }
            if (message.featuresJson != null && message.hasOwnProperty("featuresJson")) {
                properties._featuresJson = 1;
                if (!$util.isString(message.featuresJson))
                    return "featuresJson: string expected";
            }
            if (message.policyUpdateHeadersJson != null && message.hasOwnProperty("policyUpdateHeadersJson")) {
                properties._policyUpdateHeadersJson = 1;
                if (!$util.isString(message.policyUpdateHeadersJson))
                    return "policyUpdateHeadersJson: string expected";
            }
            if (message.policyUpdateBody != null && message.hasOwnProperty("policyUpdateBody")) {
                properties._policyUpdateBody = 1;
                if (!(message.policyUpdateBody && typeof message.policyUpdateBody.length === "number" || $util.isString(message.policyUpdateBody)))
                    return "policyUpdateBody: buffer expected";
            }
            if (message.activeRules != null && message.hasOwnProperty("activeRules")) {
                if (!Array.isArray(message.activeRules))
                    return "activeRules: array expected";
                for (var i = 0; i < message.activeRules.length; ++i) {
                    var error = $root.bench.ActiveRule.verify(message.activeRules[i], _depth + 1);
                    if (error)
                        return "activeRules." + error;
                }
            }
            if (message.ruleState != null && message.hasOwnProperty("ruleState")) {
                if (!Array.isArray(message.ruleState))
                    return "ruleState: array expected";
                for (var i = 0; i < message.ruleState.length; ++i) {
                    var error = $root.bench.RuleStateEntry.verify(message.ruleState[i], _depth + 1);
                    if (error)
                        return "ruleState." + error;
                }
            }
            if (message.transferJson != null && message.hasOwnProperty("transferJson")) {
                properties._transferJson = 1;
                if (!$util.isString(message.transferJson))
                    return "transferJson: string expected";
            }
            if (message.earlyPromoteJson != null && message.hasOwnProperty("earlyPromoteJson")) {
                properties._earlyPromoteJson = 1;
                if (!$util.isString(message.earlyPromoteJson))
                    return "earlyPromoteJson: string expected";
            }
            return null;
        };

        /**
         * Creates a Call message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.Call
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.Call} Call
         */
        Call.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.Call)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.Call();
            if (object.callRef != null)
                if (typeof object.callRef !== "string" || object.callRef.length)
                    message.callRef = String(object.callRef);
            if (object.aLeg != null) {
                if (typeof object.aLeg !== "object")
                    throw TypeError(".bench.Call.aLeg: object expected");
                message.aLeg = $root.bench.Leg.fromObject(object.aLeg, _depth + 1);
            }
            if (object.bLegs) {
                if (!Array.isArray(object.bLegs))
                    throw TypeError(".bench.Call.bLegs: array expected");
                message.bLegs = Array(object.bLegs.length);
                for (var i = 0; i < object.bLegs.length; ++i) {
                    if (typeof object.bLegs[i] !== "object")
                        throw TypeError(".bench.Call.bLegs: object expected");
                    message.bLegs[i] = $root.bench.Leg.fromObject(object.bLegs[i], _depth + 1);
                }
            }
            if (object.activePeer != null) {
                if (typeof object.activePeer !== "object")
                    throw TypeError(".bench.Call.activePeer: object expected");
                message.activePeer = $root.bench.ActivePeer.fromObject(object.activePeer, _depth + 1);
            }
            if (object.callbackContext != null)
                message.callbackContext = String(object.callbackContext);
            if (object.billingContext != null)
                message.billingContext = String(object.billingContext);
            if (object.aLegInvite != null) {
                if (typeof object.aLegInvite !== "object")
                    throw TypeError(".bench.Call.aLegInvite: object expected");
                message.aLegInvite = $root.bench.ALegInvite.fromObject(object.aLegInvite, _depth + 1);
            }
            if (object.limiterEntries) {
                if (!Array.isArray(object.limiterEntries))
                    throw TypeError(".bench.Call.limiterEntries: array expected");
                message.limiterEntries = Array(object.limiterEntries.length);
                for (var i = 0; i < object.limiterEntries.length; ++i) {
                    if (typeof object.limiterEntries[i] !== "object")
                        throw TypeError(".bench.Call.limiterEntries: object expected");
                    message.limiterEntries[i] = $root.bench.CallLimiterState.fromObject(object.limiterEntries[i], _depth + 1);
                }
            }
            if (object.timers) {
                if (!Array.isArray(object.timers))
                    throw TypeError(".bench.Call.timers: array expected");
                message.timers = Array(object.timers.length);
                for (var i = 0; i < object.timers.length; ++i) {
                    if (typeof object.timers[i] !== "object")
                        throw TypeError(".bench.Call.timers: object expected");
                    message.timers[i] = $root.bench.TimerEntry.fromObject(object.timers[i], _depth + 1);
                }
            }
            if (object.cdrEvents) {
                if (!Array.isArray(object.cdrEvents))
                    throw TypeError(".bench.Call.cdrEvents: array expected");
                message.cdrEvents = Array(object.cdrEvents.length);
                for (var i = 0; i < object.cdrEvents.length; ++i) {
                    if (typeof object.cdrEvents[i] !== "object")
                        throw TypeError(".bench.Call.cdrEvents: object expected");
                    message.cdrEvents[i] = $root.bench.CdrEvent.fromObject(object.cdrEvents[i], _depth + 1);
                }
            }
            if (object.state != null)
                if (typeof object.state !== "string" || object.state.length)
                    message.state = String(object.state);
            if (object.createdAt != null)
                if (Number(object.createdAt) !== 0)
                    message.createdAt = Number(object.createdAt);
            if (object.aLegPendingVias) {
                if (!Array.isArray(object.aLegPendingVias))
                    throw TypeError(".bench.Call.aLegPendingVias: array expected");
                message.aLegPendingVias = Array(object.aLegPendingVias.length);
                for (var i = 0; i < object.aLegPendingVias.length; ++i)
                    message.aLegPendingVias[i] = String(object.aLegPendingVias[i]);
            }
            if (object.aLegPendingCSeq != null)
                message.aLegPendingCSeq = object.aLegPendingCSeq | 0;
            if (object.tagMap) {
                if (!Array.isArray(object.tagMap))
                    throw TypeError(".bench.Call.tagMap: array expected");
                message.tagMap = Array(object.tagMap.length);
                for (var i = 0; i < object.tagMap.length; ++i) {
                    if (typeof object.tagMap[i] !== "object")
                        throw TypeError(".bench.Call.tagMap: object expected");
                    message.tagMap[i] = $root.bench.TagMapping.fromObject(object.tagMap[i], _depth + 1);
                }
            }
            if (object.traceId != null)
                message.traceId = String(object.traceId);
            if (object.rootSpanId != null)
                message.rootSpanId = String(object.rootSpanId);
            if (object.sampled != null)
                message.sampled = Boolean(object.sampled);
            if (object.workerIndex != null)
                message.workerIndex = object.workerIndex | 0;
            if (object.topology != null) {
                if (typeof object.topology !== "object")
                    throw TypeError(".bench.Call.topology: object expected");
                message.topology = $root.bench.CallTopology.fromObject(object.topology, _depth + 1);
            }
            if (object.emergency != null)
                message.emergency = Boolean(object.emergency);
            if (object.featuresJson != null)
                message.featuresJson = String(object.featuresJson);
            if (object.policyUpdateHeadersJson != null)
                message.policyUpdateHeadersJson = String(object.policyUpdateHeadersJson);
            if (object.policyUpdateBody != null)
                if (typeof object.policyUpdateBody === "string")
                    $util.base64.decode(object.policyUpdateBody, message.policyUpdateBody = $util.newBuffer($util.base64.length(object.policyUpdateBody)), 0);
                else if (object.policyUpdateBody.length >= 0)
                    message.policyUpdateBody = object.policyUpdateBody;
            if (object.activeRules) {
                if (!Array.isArray(object.activeRules))
                    throw TypeError(".bench.Call.activeRules: array expected");
                message.activeRules = Array(object.activeRules.length);
                for (var i = 0; i < object.activeRules.length; ++i) {
                    if (typeof object.activeRules[i] !== "object")
                        throw TypeError(".bench.Call.activeRules: object expected");
                    message.activeRules[i] = $root.bench.ActiveRule.fromObject(object.activeRules[i], _depth + 1);
                }
            }
            if (object.ruleState) {
                if (!Array.isArray(object.ruleState))
                    throw TypeError(".bench.Call.ruleState: array expected");
                message.ruleState = Array(object.ruleState.length);
                for (var i = 0; i < object.ruleState.length; ++i) {
                    if (typeof object.ruleState[i] !== "object")
                        throw TypeError(".bench.Call.ruleState: object expected");
                    message.ruleState[i] = $root.bench.RuleStateEntry.fromObject(object.ruleState[i], _depth + 1);
                }
            }
            if (object.transferJson != null)
                message.transferJson = String(object.transferJson);
            if (object.earlyPromoteJson != null)
                message.earlyPromoteJson = String(object.earlyPromoteJson);
            return message;
        };

        /**
         * Creates a plain object from a Call message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.Call
         * @static
         * @param {bench.Call} message Call
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Call.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.arrays || options.defaults) {
                object.bLegs = [];
                object.limiterEntries = [];
                object.timers = [];
                object.cdrEvents = [];
                object.aLegPendingVias = [];
                object.tagMap = [];
                object.activeRules = [];
                object.ruleState = [];
            }
            if (options.defaults) {
                object.callRef = "";
                object.aLeg = null;
                object.aLegInvite = null;
                object.state = "";
                object.createdAt = 0;
            }
            if (message.callRef != null && message.hasOwnProperty("callRef"))
                object.callRef = message.callRef;
            if (message.aLeg != null && message.hasOwnProperty("aLeg"))
                object.aLeg = $root.bench.Leg.toObject(message.aLeg, options, _depth + 1);
            if (message.bLegs && message.bLegs.length) {
                object.bLegs = Array(message.bLegs.length);
                for (var j = 0; j < message.bLegs.length; ++j)
                    object.bLegs[j] = $root.bench.Leg.toObject(message.bLegs[j], options, _depth + 1);
            }
            if (message.activePeer != null && message.hasOwnProperty("activePeer"))
                object.activePeer = $root.bench.ActivePeer.toObject(message.activePeer, options, _depth + 1);
            if (message.callbackContext != null && message.hasOwnProperty("callbackContext"))
                object.callbackContext = message.callbackContext;
            if (message.billingContext != null && message.hasOwnProperty("billingContext"))
                object.billingContext = message.billingContext;
            if (message.aLegInvite != null && message.hasOwnProperty("aLegInvite"))
                object.aLegInvite = $root.bench.ALegInvite.toObject(message.aLegInvite, options, _depth + 1);
            if (message.limiterEntries && message.limiterEntries.length) {
                object.limiterEntries = Array(message.limiterEntries.length);
                for (var j = 0; j < message.limiterEntries.length; ++j)
                    object.limiterEntries[j] = $root.bench.CallLimiterState.toObject(message.limiterEntries[j], options, _depth + 1);
            }
            if (message.timers && message.timers.length) {
                object.timers = Array(message.timers.length);
                for (var j = 0; j < message.timers.length; ++j)
                    object.timers[j] = $root.bench.TimerEntry.toObject(message.timers[j], options, _depth + 1);
            }
            if (message.cdrEvents && message.cdrEvents.length) {
                object.cdrEvents = Array(message.cdrEvents.length);
                for (var j = 0; j < message.cdrEvents.length; ++j)
                    object.cdrEvents[j] = $root.bench.CdrEvent.toObject(message.cdrEvents[j], options, _depth + 1);
            }
            if (message.state != null && message.hasOwnProperty("state"))
                object.state = message.state;
            if (message.createdAt != null && message.hasOwnProperty("createdAt"))
                object.createdAt = options.json && !isFinite(message.createdAt) ? String(message.createdAt) : message.createdAt;
            if (message.aLegPendingVias && message.aLegPendingVias.length) {
                object.aLegPendingVias = Array(message.aLegPendingVias.length);
                for (var j = 0; j < message.aLegPendingVias.length; ++j)
                    object.aLegPendingVias[j] = message.aLegPendingVias[j];
            }
            if (message.aLegPendingCSeq != null && message.hasOwnProperty("aLegPendingCSeq"))
                object.aLegPendingCSeq = message.aLegPendingCSeq;
            if (message.tagMap && message.tagMap.length) {
                object.tagMap = Array(message.tagMap.length);
                for (var j = 0; j < message.tagMap.length; ++j)
                    object.tagMap[j] = $root.bench.TagMapping.toObject(message.tagMap[j], options, _depth + 1);
            }
            if (message.traceId != null && message.hasOwnProperty("traceId"))
                object.traceId = message.traceId;
            if (message.rootSpanId != null && message.hasOwnProperty("rootSpanId"))
                object.rootSpanId = message.rootSpanId;
            if (message.sampled != null && message.hasOwnProperty("sampled"))
                object.sampled = message.sampled;
            if (message.workerIndex != null && message.hasOwnProperty("workerIndex"))
                object.workerIndex = message.workerIndex;
            if (message.topology != null && message.hasOwnProperty("topology"))
                object.topology = $root.bench.CallTopology.toObject(message.topology, options, _depth + 1);
            if (message.emergency != null && message.hasOwnProperty("emergency"))
                object.emergency = message.emergency;
            if (message.featuresJson != null && message.hasOwnProperty("featuresJson"))
                object.featuresJson = message.featuresJson;
            if (message.policyUpdateHeadersJson != null && message.hasOwnProperty("policyUpdateHeadersJson"))
                object.policyUpdateHeadersJson = message.policyUpdateHeadersJson;
            if (message.policyUpdateBody != null && message.hasOwnProperty("policyUpdateBody"))
                object.policyUpdateBody = options.bytes === String ? $util.base64.encode(message.policyUpdateBody, 0, message.policyUpdateBody.length) : options.bytes === Array ? Array.prototype.slice.call(message.policyUpdateBody) : message.policyUpdateBody;
            if (message.activeRules && message.activeRules.length) {
                object.activeRules = Array(message.activeRules.length);
                for (var j = 0; j < message.activeRules.length; ++j)
                    object.activeRules[j] = $root.bench.ActiveRule.toObject(message.activeRules[j], options, _depth + 1);
            }
            if (message.ruleState && message.ruleState.length) {
                object.ruleState = Array(message.ruleState.length);
                for (var j = 0; j < message.ruleState.length; ++j)
                    object.ruleState[j] = $root.bench.RuleStateEntry.toObject(message.ruleState[j], options, _depth + 1);
            }
            if (message.transferJson != null && message.hasOwnProperty("transferJson"))
                object.transferJson = message.transferJson;
            if (message.earlyPromoteJson != null && message.hasOwnProperty("earlyPromoteJson"))
                object.earlyPromoteJson = message.earlyPromoteJson;
            return object;
        };

        /**
         * Converts this Call to JSON.
         * @function toJSON
         * @memberof bench.Call
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Call.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for Call
         * @function getTypeUrl
         * @memberof bench.Call
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        Call.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.Call";
        };

        return Call;
    })();

    bench.Frame = (function() {

        /**
         * Properties of a Frame.
         * @typedef {Object} bench.Frame.$Properties
         * @property {number|null} [gen] Frame gen
         * @property {number|null} [counter] Frame counter
         * @property {string|null} [op] Frame op
         * @property {string|null} [partition] Frame partition
         * @property {string|null} [callRef] Frame callRef
         * @property {Uint8Array|null} [body] Frame body
         * @property {number|null} [bodyTtlRemainingSec] Frame bodyTtlRemainingSec
         * @property {number|null} [latencyMs] Frame latencyMs
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */

        /**
         * Properties of a Frame.
         * @memberof bench
         * @interface IFrame
         * @augments bench.Frame.$Properties
         * @deprecated Use bench.Frame.$Properties instead.
         */

        /**
         * Shape of a Frame.
         * @typedef {bench.Frame.$Properties} bench.Frame.$Shape
         */

        /**
         * Constructs a new Frame.
         * @memberof bench
         * @classdesc Represents a Frame.
         * @constructor
         * @param {bench.Frame.$Properties=} [properties] Properties to set
         * @property {Array.<Uint8Array>} [$unknowns] Unknown fields preserved while decoding
         */
        function Frame(properties) {
            if (properties)
                for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        }

        /**
         * Frame gen.
         * @member {number} gen
         * @memberof bench.Frame
         * @instance
         */
        Frame.prototype.gen = 0;

        /**
         * Frame counter.
         * @member {number} counter
         * @memberof bench.Frame
         * @instance
         */
        Frame.prototype.counter = 0;

        /**
         * Frame op.
         * @member {string} op
         * @memberof bench.Frame
         * @instance
         */
        Frame.prototype.op = "";

        /**
         * Frame partition.
         * @member {string} partition
         * @memberof bench.Frame
         * @instance
         */
        Frame.prototype.partition = "";

        /**
         * Frame callRef.
         * @member {string} callRef
         * @memberof bench.Frame
         * @instance
         */
        Frame.prototype.callRef = "";

        /**
         * Frame body.
         * @member {Uint8Array} body
         * @memberof bench.Frame
         * @instance
         */
        Frame.prototype.body = $util.newBuffer([]);

        /**
         * Frame bodyTtlRemainingSec.
         * @member {number} bodyTtlRemainingSec
         * @memberof bench.Frame
         * @instance
         */
        Frame.prototype.bodyTtlRemainingSec = 0;

        /**
         * Frame latencyMs.
         * @member {number} latencyMs
         * @memberof bench.Frame
         * @instance
         */
        Frame.prototype.latencyMs = 0;

        /**
         * Creates a new Frame instance using the specified properties.
         * @function create
         * @memberof bench.Frame
         * @static
         * @param {bench.Frame.$Properties=} [properties] Properties to set
         * @returns {bench.Frame} Frame instance
         * @type {{
         *   (properties: bench.Frame.$Shape): bench.Frame & bench.Frame.$Shape;
         *   (properties?: bench.Frame.$Properties): bench.Frame;
         * }}
         */
        Frame.create = function create(properties) {
            return new Frame(properties);
        };

        /**
         * Encodes the specified Frame message. Does not implicitly {@link bench.Frame.verify|verify} messages.
         * @function encode
         * @memberof bench.Frame
         * @static
         * @param {bench.Frame.$Properties} message Frame message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Frame.encode = function encode(message, writer, _depth) {
            if (!writer)
                writer = $Writer.create();
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            if (message.gen != null && Object.hasOwnProperty.call(message, "gen"))
                writer.uint32(/* id 1, wireType 0 =*/8).int32(message.gen);
            if (message.counter != null && Object.hasOwnProperty.call(message, "counter"))
                writer.uint32(/* id 2, wireType 0 =*/16).int32(message.counter);
            if (message.op != null && Object.hasOwnProperty.call(message, "op"))
                writer.uint32(/* id 3, wireType 2 =*/26).string(message.op);
            if (message.partition != null && Object.hasOwnProperty.call(message, "partition"))
                writer.uint32(/* id 4, wireType 2 =*/34).string(message.partition);
            if (message.callRef != null && Object.hasOwnProperty.call(message, "callRef"))
                writer.uint32(/* id 5, wireType 2 =*/42).string(message.callRef);
            if (message.body != null && Object.hasOwnProperty.call(message, "body"))
                writer.uint32(/* id 6, wireType 2 =*/50).bytes(message.body);
            if (message.bodyTtlRemainingSec != null && Object.hasOwnProperty.call(message, "bodyTtlRemainingSec"))
                writer.uint32(/* id 7, wireType 0 =*/56).int32(message.bodyTtlRemainingSec);
            if (message.latencyMs != null && Object.hasOwnProperty.call(message, "latencyMs"))
                writer.uint32(/* id 8, wireType 0 =*/64).int32(message.latencyMs);
            if (message.$unknowns != null && Object.hasOwnProperty.call(message, "$unknowns"))
                for (var i = 0; i < message.$unknowns.length; ++i)
                    writer.raw(message.$unknowns[i]);
            return writer;
        };

        /**
         * Encodes the specified Frame message, length delimited. Does not implicitly {@link bench.Frame.verify|verify} messages.
         * @function encodeDelimited
         * @memberof bench.Frame
         * @static
         * @param {bench.Frame.$Properties} message Frame message or plain object to encode
         * @param {$protobuf.Writer} [writer] Writer to encode to
         * @returns {$protobuf.Writer} Writer
         */
        Frame.encodeDelimited = function encodeDelimited(message, writer) {
            return this.encode(message, writer && writer.len ? writer.fork() : writer).ldelim();
        };

        /**
         * Decodes a Frame message from the specified reader or buffer.
         * @function decode
         * @memberof bench.Frame
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @param {number} [length] Message length if known beforehand
         * @returns {bench.Frame & bench.Frame.$Shape} Frame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Frame.decode = function decode(reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw Error("max depth exceeded");
            var end = length === undefined ? reader.len : reader.pos + length, message = _target || new $root.bench.Frame(), value;
            while (reader.pos < end) {
                var start = reader.pos;
                var tag = reader.uint32();
                if (tag === _end) {
                    _end = undefined;
                    break;
                }
                var wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.int32())
                            message.gen = value;
                        else
                            delete message.gen;
                        continue;
                    }
                case 2: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.int32())
                            message.counter = value;
                        else
                            delete message.counter;
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.op = value;
                        else
                            delete message.op;
                        continue;
                    }
                case 4: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.partition = value;
                        else
                            delete message.partition;
                        continue;
                    }
                case 5: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.string()).length)
                            message.callRef = value;
                        else
                            delete message.callRef;
                        continue;
                    }
                case 6: {
                        if (wireType !== 2)
                            break;
                        if ((value = reader.bytes()).length)
                            message.body = value;
                        else
                            delete message.body;
                        continue;
                    }
                case 7: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.int32())
                            message.bodyTtlRemainingSec = value;
                        else
                            delete message.bodyTtlRemainingSec;
                        continue;
                    }
                case 8: {
                        if (wireType !== 0)
                            break;
                        if (value = reader.int32())
                            message.latencyMs = value;
                        else
                            delete message.latencyMs;
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                $util.makeProp(message, "$unknowns", false);
                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
            }
            if (_end !== undefined)
                throw Error("missing end group");
            return message;
        };

        /**
         * Decodes a Frame message from the specified reader or buffer, length delimited.
         * @function decodeDelimited
         * @memberof bench.Frame
         * @static
         * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
         * @returns {bench.Frame & bench.Frame.$Shape} Frame
         * @throws {Error} If the payload is not a reader or valid buffer
         * @throws {$protobuf.util.ProtocolError} If required fields are missing
         */
        Frame.decodeDelimited = function decodeDelimited(reader) {
            if (!(reader instanceof $Reader))
                reader = new $Reader(reader);
            return this.decode(reader, reader.uint32());
        };

        /**
         * Verifies a Frame message.
         * @function verify
         * @memberof bench.Frame
         * @static
         * @param {Object.<string,*>} message Plain object to verify
         * @returns {string|null} `null` if valid, otherwise the reason why it is not
         */
        Frame.verify = function verify(message, _depth) {
            if (typeof message !== "object" || message === null)
                return "object expected";
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                return "max depth exceeded";
            if (message.gen != null && message.hasOwnProperty("gen"))
                if (!$util.isInteger(message.gen))
                    return "gen: integer expected";
            if (message.counter != null && message.hasOwnProperty("counter"))
                if (!$util.isInteger(message.counter))
                    return "counter: integer expected";
            if (message.op != null && message.hasOwnProperty("op"))
                if (!$util.isString(message.op))
                    return "op: string expected";
            if (message.partition != null && message.hasOwnProperty("partition"))
                if (!$util.isString(message.partition))
                    return "partition: string expected";
            if (message.callRef != null && message.hasOwnProperty("callRef"))
                if (!$util.isString(message.callRef))
                    return "callRef: string expected";
            if (message.body != null && message.hasOwnProperty("body"))
                if (!(message.body && typeof message.body.length === "number" || $util.isString(message.body)))
                    return "body: buffer expected";
            if (message.bodyTtlRemainingSec != null && message.hasOwnProperty("bodyTtlRemainingSec"))
                if (!$util.isInteger(message.bodyTtlRemainingSec))
                    return "bodyTtlRemainingSec: integer expected";
            if (message.latencyMs != null && message.hasOwnProperty("latencyMs"))
                if (!$util.isInteger(message.latencyMs))
                    return "latencyMs: integer expected";
            return null;
        };

        /**
         * Creates a Frame message from a plain object. Also converts values to their respective internal types.
         * @function fromObject
         * @memberof bench.Frame
         * @static
         * @param {Object.<string,*>} object Plain object
         * @returns {bench.Frame} Frame
         */
        Frame.fromObject = function fromObject(object, _depth) {
            if (object instanceof $root.bench.Frame)
                return object;
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var message = new $root.bench.Frame();
            if (object.gen != null)
                if (Number(object.gen) !== 0)
                    message.gen = object.gen | 0;
            if (object.counter != null)
                if (Number(object.counter) !== 0)
                    message.counter = object.counter | 0;
            if (object.op != null)
                if (typeof object.op !== "string" || object.op.length)
                    message.op = String(object.op);
            if (object.partition != null)
                if (typeof object.partition !== "string" || object.partition.length)
                    message.partition = String(object.partition);
            if (object.callRef != null)
                if (typeof object.callRef !== "string" || object.callRef.length)
                    message.callRef = String(object.callRef);
            if (object.body != null)
                if (object.body.length)
                    if (typeof object.body === "string")
                        $util.base64.decode(object.body, message.body = $util.newBuffer($util.base64.length(object.body)), 0);
                    else if (object.body.length >= 0)
                        message.body = object.body;
            if (object.bodyTtlRemainingSec != null)
                if (Number(object.bodyTtlRemainingSec) !== 0)
                    message.bodyTtlRemainingSec = object.bodyTtlRemainingSec | 0;
            if (object.latencyMs != null)
                if (Number(object.latencyMs) !== 0)
                    message.latencyMs = object.latencyMs | 0;
            return message;
        };

        /**
         * Creates a plain object from a Frame message. Also converts values to other types if specified.
         * @function toObject
         * @memberof bench.Frame
         * @static
         * @param {bench.Frame} message Frame
         * @param {$protobuf.IConversionOptions} [options] Conversion options
         * @returns {Object.<string,*>} Plain object
         */
        Frame.toObject = function toObject(message, options, _depth) {
            if (!options)
                options = {};
            if (_depth === undefined)
                _depth = 0;
            if (_depth > $util.recursionLimit)
                throw Error("max depth exceeded");
            var object = {};
            if (options.defaults) {
                object.gen = 0;
                object.counter = 0;
                object.op = "";
                object.partition = "";
                object.callRef = "";
                if (options.bytes === String)
                    object.body = "";
                else {
                    object.body = [];
                    if (options.bytes !== Array)
                        object.body = $util.newBuffer(object.body);
                }
                object.bodyTtlRemainingSec = 0;
                object.latencyMs = 0;
            }
            if (message.gen != null && message.hasOwnProperty("gen"))
                object.gen = message.gen;
            if (message.counter != null && message.hasOwnProperty("counter"))
                object.counter = message.counter;
            if (message.op != null && message.hasOwnProperty("op"))
                object.op = message.op;
            if (message.partition != null && message.hasOwnProperty("partition"))
                object.partition = message.partition;
            if (message.callRef != null && message.hasOwnProperty("callRef"))
                object.callRef = message.callRef;
            if (message.body != null && message.hasOwnProperty("body"))
                object.body = options.bytes === String ? $util.base64.encode(message.body, 0, message.body.length) : options.bytes === Array ? Array.prototype.slice.call(message.body) : message.body;
            if (message.bodyTtlRemainingSec != null && message.hasOwnProperty("bodyTtlRemainingSec"))
                object.bodyTtlRemainingSec = message.bodyTtlRemainingSec;
            if (message.latencyMs != null && message.hasOwnProperty("latencyMs"))
                object.latencyMs = message.latencyMs;
            return object;
        };

        /**
         * Converts this Frame to JSON.
         * @function toJSON
         * @memberof bench.Frame
         * @instance
         * @returns {Object.<string,*>} JSON object
         */
        Frame.prototype.toJSON = function toJSON() {
            return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
        };

        /**
         * Gets the type url for Frame
         * @function getTypeUrl
         * @memberof bench.Frame
         * @static
         * @param {string} [prefix] Custom type url prefix, defaults to `"type.googleapis.com"`
         * @returns {string} The type url
         */
        Frame.getTypeUrl = function getTypeUrl(prefix) {
            if (prefix === undefined)
                prefix = "type.googleapis.com";
            return prefix + "/bench.Frame";
        };

        return Frame;
    })();

    return bench;
})();

module.exports = $root;
