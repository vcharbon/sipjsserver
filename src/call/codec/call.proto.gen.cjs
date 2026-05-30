/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars*/
"use strict";

var $protobuf = require("protobufjs/minimal");

// Common aliases
var $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;

// Exported root namespace
var $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

$root.sipjsserver = (function() {

    /**
     * Namespace sipjsserver.
     * @exports sipjsserver
     * @namespace
     */
    var sipjsserver = {};

    sipjsserver.call = (function() {

        /**
         * Namespace call.
         * @memberof sipjsserver
         * @namespace
         */
        var call = {};

        call.RemoteInfo = (function() {

            /**
             * Properties of a RemoteInfo.
             * @memberof sipjsserver.call
             * @interface IRemoteInfo
             * @property {string|null} [address] RemoteInfo address
             * @property {number|null} [port] RemoteInfo port
             */

            /**
             * Constructs a new RemoteInfo.
             * @memberof sipjsserver.call
             * @classdesc Represents a RemoteInfo.
             * @implements IRemoteInfo
             * @constructor
             * @param {sipjsserver.call.IRemoteInfo=} [properties] Properties to set
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
             * @memberof sipjsserver.call.RemoteInfo
             * @instance
             */
            RemoteInfo.prototype.address = "";

            /**
             * RemoteInfo port.
             * @member {number} port
             * @memberof sipjsserver.call.RemoteInfo
             * @instance
             */
            RemoteInfo.prototype.port = 0;

            /**
             * Creates a new RemoteInfo instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.RemoteInfo
             * @static
             * @param {sipjsserver.call.IRemoteInfo=} [properties] Properties to set
             * @returns {sipjsserver.call.RemoteInfo} RemoteInfo instance
             */
            RemoteInfo.create = function create(properties) {
                return new RemoteInfo(properties);
            };

            /**
             * Encodes the specified RemoteInfo message. Does not implicitly {@link sipjsserver.call.RemoteInfo.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.RemoteInfo
             * @static
             * @param {sipjsserver.call.IRemoteInfo} message RemoteInfo message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            RemoteInfo.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.address != null && Object.hasOwnProperty.call(message, "address"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.address);
                if (message.port != null && Object.hasOwnProperty.call(message, "port"))
                    writer.uint32(/* id 2, wireType 0 =*/16).int32(message.port);
                return writer;
            };

            /**
             * Encodes the specified RemoteInfo message, length delimited. Does not implicitly {@link sipjsserver.call.RemoteInfo.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.RemoteInfo
             * @static
             * @param {sipjsserver.call.IRemoteInfo} message RemoteInfo message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            RemoteInfo.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a RemoteInfo message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.RemoteInfo
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.RemoteInfo} RemoteInfo
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            RemoteInfo.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.RemoteInfo();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.address = reader.string();
                            break;
                        }
                    case 2: {
                            message.port = reader.int32();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a RemoteInfo message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.RemoteInfo
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.RemoteInfo} RemoteInfo
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
             * @memberof sipjsserver.call.RemoteInfo
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            RemoteInfo.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
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
             * @memberof sipjsserver.call.RemoteInfo
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.RemoteInfo} RemoteInfo
             */
            RemoteInfo.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.RemoteInfo)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.RemoteInfo();
                if (object.address != null)
                    message.address = String(object.address);
                if (object.port != null)
                    message.port = object.port | 0;
                return message;
            };

            /**
             * Creates a plain object from a RemoteInfo message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.RemoteInfo
             * @static
             * @param {sipjsserver.call.RemoteInfo} message RemoteInfo
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            RemoteInfo.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
             * @memberof sipjsserver.call.RemoteInfo
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            RemoteInfo.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for RemoteInfo
             * @function getTypeUrl
             * @memberof sipjsserver.call.RemoteInfo
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            RemoteInfo.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.RemoteInfo";
            };

            return RemoteInfo;
        })();

        call.SipHeader = (function() {

            /**
             * Properties of a SipHeader.
             * @memberof sipjsserver.call
             * @interface ISipHeader
             * @property {string|null} [name] SipHeader name
             * @property {string|null} [value] SipHeader value
             */

            /**
             * Constructs a new SipHeader.
             * @memberof sipjsserver.call
             * @classdesc Represents a SipHeader.
             * @implements ISipHeader
             * @constructor
             * @param {sipjsserver.call.ISipHeader=} [properties] Properties to set
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
             * @memberof sipjsserver.call.SipHeader
             * @instance
             */
            SipHeader.prototype.name = "";

            /**
             * SipHeader value.
             * @member {string} value
             * @memberof sipjsserver.call.SipHeader
             * @instance
             */
            SipHeader.prototype.value = "";

            /**
             * Creates a new SipHeader instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.SipHeader
             * @static
             * @param {sipjsserver.call.ISipHeader=} [properties] Properties to set
             * @returns {sipjsserver.call.SipHeader} SipHeader instance
             */
            SipHeader.create = function create(properties) {
                return new SipHeader(properties);
            };

            /**
             * Encodes the specified SipHeader message. Does not implicitly {@link sipjsserver.call.SipHeader.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.SipHeader
             * @static
             * @param {sipjsserver.call.ISipHeader} message SipHeader message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            SipHeader.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.name != null && Object.hasOwnProperty.call(message, "name"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.name);
                if (message.value != null && Object.hasOwnProperty.call(message, "value"))
                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.value);
                return writer;
            };

            /**
             * Encodes the specified SipHeader message, length delimited. Does not implicitly {@link sipjsserver.call.SipHeader.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.SipHeader
             * @static
             * @param {sipjsserver.call.ISipHeader} message SipHeader message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            SipHeader.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a SipHeader message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.SipHeader
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.SipHeader} SipHeader
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            SipHeader.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.SipHeader();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.name = reader.string();
                            break;
                        }
                    case 2: {
                            message.value = reader.string();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a SipHeader message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.SipHeader
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.SipHeader} SipHeader
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
             * @memberof sipjsserver.call.SipHeader
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            SipHeader.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
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
             * @memberof sipjsserver.call.SipHeader
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.SipHeader} SipHeader
             */
            SipHeader.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.SipHeader)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.SipHeader();
                if (object.name != null)
                    message.name = String(object.name);
                if (object.value != null)
                    message.value = String(object.value);
                return message;
            };

            /**
             * Creates a plain object from a SipHeader message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.SipHeader
             * @static
             * @param {sipjsserver.call.SipHeader} message SipHeader
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            SipHeader.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
             * @memberof sipjsserver.call.SipHeader
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            SipHeader.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for SipHeader
             * @function getTypeUrl
             * @memberof sipjsserver.call.SipHeader
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            SipHeader.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.SipHeader";
            };

            return SipHeader;
        })();

        call.PendingRequest = (function() {

            /**
             * Properties of a PendingRequest.
             * @memberof sipjsserver.call
             * @interface IPendingRequest
             * @property {string|null} [method] PendingRequest method
             * @property {number|null} [outboundCSeq] PendingRequest outboundCSeq
             * @property {number|null} [inboundCSeq] PendingRequest inboundCSeq
             * @property {Array.<string>|null} [sourceVias] PendingRequest sourceVias
             * @property {string|null} [sourceCallId] PendingRequest sourceCallId
             * @property {string|null} [sourceFrom] PendingRequest sourceFrom
             * @property {string|null} [sourceTo] PendingRequest sourceTo
             * @property {string|null} [direction] PendingRequest direction
             */

            /**
             * Constructs a new PendingRequest.
             * @memberof sipjsserver.call
             * @classdesc Represents a PendingRequest.
             * @implements IPendingRequest
             * @constructor
             * @param {sipjsserver.call.IPendingRequest=} [properties] Properties to set
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
             * @memberof sipjsserver.call.PendingRequest
             * @instance
             */
            PendingRequest.prototype.method = "";

            /**
             * PendingRequest outboundCSeq.
             * @member {number} outboundCSeq
             * @memberof sipjsserver.call.PendingRequest
             * @instance
             */
            PendingRequest.prototype.outboundCSeq = 0;

            /**
             * PendingRequest inboundCSeq.
             * @member {number} inboundCSeq
             * @memberof sipjsserver.call.PendingRequest
             * @instance
             */
            PendingRequest.prototype.inboundCSeq = 0;

            /**
             * PendingRequest sourceVias.
             * @member {Array.<string>} sourceVias
             * @memberof sipjsserver.call.PendingRequest
             * @instance
             */
            PendingRequest.prototype.sourceVias = $util.emptyArray;

            /**
             * PendingRequest sourceCallId.
             * @member {string} sourceCallId
             * @memberof sipjsserver.call.PendingRequest
             * @instance
             */
            PendingRequest.prototype.sourceCallId = "";

            /**
             * PendingRequest sourceFrom.
             * @member {string} sourceFrom
             * @memberof sipjsserver.call.PendingRequest
             * @instance
             */
            PendingRequest.prototype.sourceFrom = "";

            /**
             * PendingRequest sourceTo.
             * @member {string} sourceTo
             * @memberof sipjsserver.call.PendingRequest
             * @instance
             */
            PendingRequest.prototype.sourceTo = "";

            /**
             * PendingRequest direction.
             * @member {string} direction
             * @memberof sipjsserver.call.PendingRequest
             * @instance
             */
            PendingRequest.prototype.direction = "";

            /**
             * Creates a new PendingRequest instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.PendingRequest
             * @static
             * @param {sipjsserver.call.IPendingRequest=} [properties] Properties to set
             * @returns {sipjsserver.call.PendingRequest} PendingRequest instance
             */
            PendingRequest.create = function create(properties) {
                return new PendingRequest(properties);
            };

            /**
             * Encodes the specified PendingRequest message. Does not implicitly {@link sipjsserver.call.PendingRequest.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.PendingRequest
             * @static
             * @param {sipjsserver.call.IPendingRequest} message PendingRequest message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            PendingRequest.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
                return writer;
            };

            /**
             * Encodes the specified PendingRequest message, length delimited. Does not implicitly {@link sipjsserver.call.PendingRequest.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.PendingRequest
             * @static
             * @param {sipjsserver.call.IPendingRequest} message PendingRequest message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            PendingRequest.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a PendingRequest message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.PendingRequest
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.PendingRequest} PendingRequest
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            PendingRequest.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.PendingRequest();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.method = reader.string();
                            break;
                        }
                    case 2: {
                            message.outboundCSeq = reader.int32();
                            break;
                        }
                    case 3: {
                            message.inboundCSeq = reader.int32();
                            break;
                        }
                    case 4: {
                            if (!(message.sourceVias && message.sourceVias.length))
                                message.sourceVias = [];
                            message.sourceVias.push(reader.string());
                            break;
                        }
                    case 5: {
                            message.sourceCallId = reader.string();
                            break;
                        }
                    case 6: {
                            message.sourceFrom = reader.string();
                            break;
                        }
                    case 7: {
                            message.sourceTo = reader.string();
                            break;
                        }
                    case 8: {
                            message.direction = reader.string();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a PendingRequest message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.PendingRequest
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.PendingRequest} PendingRequest
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
             * @memberof sipjsserver.call.PendingRequest
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            PendingRequest.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
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
             * @memberof sipjsserver.call.PendingRequest
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.PendingRequest} PendingRequest
             */
            PendingRequest.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.PendingRequest)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.PendingRequest();
                if (object.method != null)
                    message.method = String(object.method);
                if (object.outboundCSeq != null)
                    message.outboundCSeq = object.outboundCSeq | 0;
                if (object.inboundCSeq != null)
                    message.inboundCSeq = object.inboundCSeq | 0;
                if (object.sourceVias) {
                    if (!Array.isArray(object.sourceVias))
                        throw TypeError(".sipjsserver.call.PendingRequest.sourceVias: array expected");
                    message.sourceVias = [];
                    for (var i = 0; i < object.sourceVias.length; ++i)
                        message.sourceVias[i] = String(object.sourceVias[i]);
                }
                if (object.sourceCallId != null)
                    message.sourceCallId = String(object.sourceCallId);
                if (object.sourceFrom != null)
                    message.sourceFrom = String(object.sourceFrom);
                if (object.sourceTo != null)
                    message.sourceTo = String(object.sourceTo);
                if (object.direction != null)
                    message.direction = String(object.direction);
                return message;
            };

            /**
             * Creates a plain object from a PendingRequest message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.PendingRequest
             * @static
             * @param {sipjsserver.call.PendingRequest} message PendingRequest
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            PendingRequest.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
                    object.sourceVias = [];
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
             * @memberof sipjsserver.call.PendingRequest
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            PendingRequest.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for PendingRequest
             * @function getTypeUrl
             * @memberof sipjsserver.call.PendingRequest
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            PendingRequest.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.PendingRequest";
            };

            return PendingRequest;
        })();

        call.StackDialog = (function() {

            /**
             * Properties of a StackDialog.
             * @memberof sipjsserver.call
             * @interface IStackDialog
             * @property {string|null} [callId] StackDialog callId
             * @property {string|null} [localTag] StackDialog localTag
             * @property {string|null} [remoteTag] StackDialog remoteTag
             * @property {string|null} [localUri] StackDialog localUri
             * @property {string|null} [remoteUri] StackDialog remoteUri
             * @property {string|null} [remoteTarget] StackDialog remoteTarget
             * @property {number|null} [localCSeq] StackDialog localCSeq
             * @property {Array.<string>|null} [routeSet] StackDialog routeSet
             */

            /**
             * Constructs a new StackDialog.
             * @memberof sipjsserver.call
             * @classdesc Represents a StackDialog.
             * @implements IStackDialog
             * @constructor
             * @param {sipjsserver.call.IStackDialog=} [properties] Properties to set
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
             * @memberof sipjsserver.call.StackDialog
             * @instance
             */
            StackDialog.prototype.callId = "";

            /**
             * StackDialog localTag.
             * @member {string} localTag
             * @memberof sipjsserver.call.StackDialog
             * @instance
             */
            StackDialog.prototype.localTag = "";

            /**
             * StackDialog remoteTag.
             * @member {string} remoteTag
             * @memberof sipjsserver.call.StackDialog
             * @instance
             */
            StackDialog.prototype.remoteTag = "";

            /**
             * StackDialog localUri.
             * @member {string} localUri
             * @memberof sipjsserver.call.StackDialog
             * @instance
             */
            StackDialog.prototype.localUri = "";

            /**
             * StackDialog remoteUri.
             * @member {string} remoteUri
             * @memberof sipjsserver.call.StackDialog
             * @instance
             */
            StackDialog.prototype.remoteUri = "";

            /**
             * StackDialog remoteTarget.
             * @member {string} remoteTarget
             * @memberof sipjsserver.call.StackDialog
             * @instance
             */
            StackDialog.prototype.remoteTarget = "";

            /**
             * StackDialog localCSeq.
             * @member {number} localCSeq
             * @memberof sipjsserver.call.StackDialog
             * @instance
             */
            StackDialog.prototype.localCSeq = 0;

            /**
             * StackDialog routeSet.
             * @member {Array.<string>} routeSet
             * @memberof sipjsserver.call.StackDialog
             * @instance
             */
            StackDialog.prototype.routeSet = $util.emptyArray;

            /**
             * Creates a new StackDialog instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.StackDialog
             * @static
             * @param {sipjsserver.call.IStackDialog=} [properties] Properties to set
             * @returns {sipjsserver.call.StackDialog} StackDialog instance
             */
            StackDialog.create = function create(properties) {
                return new StackDialog(properties);
            };

            /**
             * Encodes the specified StackDialog message. Does not implicitly {@link sipjsserver.call.StackDialog.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.StackDialog
             * @static
             * @param {sipjsserver.call.IStackDialog} message StackDialog message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            StackDialog.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
                return writer;
            };

            /**
             * Encodes the specified StackDialog message, length delimited. Does not implicitly {@link sipjsserver.call.StackDialog.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.StackDialog
             * @static
             * @param {sipjsserver.call.IStackDialog} message StackDialog message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            StackDialog.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a StackDialog message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.StackDialog
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.StackDialog} StackDialog
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            StackDialog.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.StackDialog();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.callId = reader.string();
                            break;
                        }
                    case 2: {
                            message.localTag = reader.string();
                            break;
                        }
                    case 3: {
                            message.remoteTag = reader.string();
                            break;
                        }
                    case 4: {
                            message.localUri = reader.string();
                            break;
                        }
                    case 5: {
                            message.remoteUri = reader.string();
                            break;
                        }
                    case 6: {
                            message.remoteTarget = reader.string();
                            break;
                        }
                    case 7: {
                            message.localCSeq = reader.int32();
                            break;
                        }
                    case 8: {
                            if (!(message.routeSet && message.routeSet.length))
                                message.routeSet = [];
                            message.routeSet.push(reader.string());
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a StackDialog message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.StackDialog
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.StackDialog} StackDialog
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
             * @memberof sipjsserver.call.StackDialog
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            StackDialog.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
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
             * @memberof sipjsserver.call.StackDialog
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.StackDialog} StackDialog
             */
            StackDialog.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.StackDialog)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.StackDialog();
                if (object.callId != null)
                    message.callId = String(object.callId);
                if (object.localTag != null)
                    message.localTag = String(object.localTag);
                if (object.remoteTag != null)
                    message.remoteTag = String(object.remoteTag);
                if (object.localUri != null)
                    message.localUri = String(object.localUri);
                if (object.remoteUri != null)
                    message.remoteUri = String(object.remoteUri);
                if (object.remoteTarget != null)
                    message.remoteTarget = String(object.remoteTarget);
                if (object.localCSeq != null)
                    message.localCSeq = object.localCSeq | 0;
                if (object.routeSet) {
                    if (!Array.isArray(object.routeSet))
                        throw TypeError(".sipjsserver.call.StackDialog.routeSet: array expected");
                    message.routeSet = [];
                    for (var i = 0; i < object.routeSet.length; ++i)
                        message.routeSet[i] = String(object.routeSet[i]);
                }
                return message;
            };

            /**
             * Creates a plain object from a StackDialog message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.StackDialog
             * @static
             * @param {sipjsserver.call.StackDialog} message StackDialog
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            StackDialog.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
                    object.routeSet = [];
                    for (var j = 0; j < message.routeSet.length; ++j)
                        object.routeSet[j] = message.routeSet[j];
                }
                return object;
            };

            /**
             * Converts this StackDialog to JSON.
             * @function toJSON
             * @memberof sipjsserver.call.StackDialog
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            StackDialog.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for StackDialog
             * @function getTypeUrl
             * @memberof sipjsserver.call.StackDialog
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            StackDialog.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.StackDialog";
            };

            return StackDialog;
        })();

        call.B2buaDialogExt = (function() {

            /**
             * Properties of a B2buaDialogExt.
             * @memberof sipjsserver.call
             * @interface IB2buaDialogExt
             * @property {number|null} [remoteCSeq] B2buaDialogExt remoteCSeq
             * @property {boolean|null} [remoteCSeqIsNull] B2buaDialogExt remoteCSeqIsNull
             * @property {Array.<sipjsserver.call.IPendingRequest>|null} [inboundPendingRequests] B2buaDialogExt inboundPendingRequests
             * @property {string|null} [ackBranch] B2buaDialogExt ackBranch
             * @property {string|null} [pendingInviteTxnJson] B2buaDialogExt pendingInviteTxnJson
             * @property {Uint8Array|null} [cachedSdp] B2buaDialogExt cachedSdp
             */

            /**
             * Constructs a new B2buaDialogExt.
             * @memberof sipjsserver.call
             * @classdesc Represents a B2buaDialogExt.
             * @implements IB2buaDialogExt
             * @constructor
             * @param {sipjsserver.call.IB2buaDialogExt=} [properties] Properties to set
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
             * @memberof sipjsserver.call.B2buaDialogExt
             * @instance
             */
            B2buaDialogExt.prototype.remoteCSeq = null;

            /**
             * B2buaDialogExt remoteCSeqIsNull.
             * @member {boolean|null|undefined} remoteCSeqIsNull
             * @memberof sipjsserver.call.B2buaDialogExt
             * @instance
             */
            B2buaDialogExt.prototype.remoteCSeqIsNull = null;

            /**
             * B2buaDialogExt inboundPendingRequests.
             * @member {Array.<sipjsserver.call.IPendingRequest>} inboundPendingRequests
             * @memberof sipjsserver.call.B2buaDialogExt
             * @instance
             */
            B2buaDialogExt.prototype.inboundPendingRequests = $util.emptyArray;

            /**
             * B2buaDialogExt ackBranch.
             * @member {string|null|undefined} ackBranch
             * @memberof sipjsserver.call.B2buaDialogExt
             * @instance
             */
            B2buaDialogExt.prototype.ackBranch = null;

            /**
             * B2buaDialogExt pendingInviteTxnJson.
             * @member {string|null|undefined} pendingInviteTxnJson
             * @memberof sipjsserver.call.B2buaDialogExt
             * @instance
             */
            B2buaDialogExt.prototype.pendingInviteTxnJson = null;

            /**
             * B2buaDialogExt cachedSdp.
             * @member {Uint8Array|null|undefined} cachedSdp
             * @memberof sipjsserver.call.B2buaDialogExt
             * @instance
             */
            B2buaDialogExt.prototype.cachedSdp = null;

            // OneOf field names bound to virtual getters and setters
            var $oneOfFields;

            /**
             * B2buaDialogExt _remoteCSeq.
             * @member {"remoteCSeq"|undefined} _remoteCSeq
             * @memberof sipjsserver.call.B2buaDialogExt
             * @instance
             */
            Object.defineProperty(B2buaDialogExt.prototype, "_remoteCSeq", {
                get: $util.oneOfGetter($oneOfFields = ["remoteCSeq"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * B2buaDialogExt _remoteCSeqIsNull.
             * @member {"remoteCSeqIsNull"|undefined} _remoteCSeqIsNull
             * @memberof sipjsserver.call.B2buaDialogExt
             * @instance
             */
            Object.defineProperty(B2buaDialogExt.prototype, "_remoteCSeqIsNull", {
                get: $util.oneOfGetter($oneOfFields = ["remoteCSeqIsNull"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * B2buaDialogExt _ackBranch.
             * @member {"ackBranch"|undefined} _ackBranch
             * @memberof sipjsserver.call.B2buaDialogExt
             * @instance
             */
            Object.defineProperty(B2buaDialogExt.prototype, "_ackBranch", {
                get: $util.oneOfGetter($oneOfFields = ["ackBranch"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * B2buaDialogExt _pendingInviteTxnJson.
             * @member {"pendingInviteTxnJson"|undefined} _pendingInviteTxnJson
             * @memberof sipjsserver.call.B2buaDialogExt
             * @instance
             */
            Object.defineProperty(B2buaDialogExt.prototype, "_pendingInviteTxnJson", {
                get: $util.oneOfGetter($oneOfFields = ["pendingInviteTxnJson"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * B2buaDialogExt _cachedSdp.
             * @member {"cachedSdp"|undefined} _cachedSdp
             * @memberof sipjsserver.call.B2buaDialogExt
             * @instance
             */
            Object.defineProperty(B2buaDialogExt.prototype, "_cachedSdp", {
                get: $util.oneOfGetter($oneOfFields = ["cachedSdp"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Creates a new B2buaDialogExt instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.B2buaDialogExt
             * @static
             * @param {sipjsserver.call.IB2buaDialogExt=} [properties] Properties to set
             * @returns {sipjsserver.call.B2buaDialogExt} B2buaDialogExt instance
             */
            B2buaDialogExt.create = function create(properties) {
                return new B2buaDialogExt(properties);
            };

            /**
             * Encodes the specified B2buaDialogExt message. Does not implicitly {@link sipjsserver.call.B2buaDialogExt.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.B2buaDialogExt
             * @static
             * @param {sipjsserver.call.IB2buaDialogExt} message B2buaDialogExt message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            B2buaDialogExt.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.remoteCSeq != null && Object.hasOwnProperty.call(message, "remoteCSeq"))
                    writer.uint32(/* id 1, wireType 0 =*/8).int32(message.remoteCSeq);
                if (message.remoteCSeqIsNull != null && Object.hasOwnProperty.call(message, "remoteCSeqIsNull"))
                    writer.uint32(/* id 2, wireType 0 =*/16).bool(message.remoteCSeqIsNull);
                if (message.inboundPendingRequests != null && message.inboundPendingRequests.length)
                    for (var i = 0; i < message.inboundPendingRequests.length; ++i)
                        $root.sipjsserver.call.PendingRequest.encode(message.inboundPendingRequests[i], writer.uint32(/* id 3, wireType 2 =*/26).fork(), q + 1).ldelim();
                if (message.ackBranch != null && Object.hasOwnProperty.call(message, "ackBranch"))
                    writer.uint32(/* id 4, wireType 2 =*/34).string(message.ackBranch);
                if (message.pendingInviteTxnJson != null && Object.hasOwnProperty.call(message, "pendingInviteTxnJson"))
                    writer.uint32(/* id 5, wireType 2 =*/42).string(message.pendingInviteTxnJson);
                if (message.cachedSdp != null && Object.hasOwnProperty.call(message, "cachedSdp"))
                    writer.uint32(/* id 6, wireType 2 =*/50).bytes(message.cachedSdp);
                return writer;
            };

            /**
             * Encodes the specified B2buaDialogExt message, length delimited. Does not implicitly {@link sipjsserver.call.B2buaDialogExt.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.B2buaDialogExt
             * @static
             * @param {sipjsserver.call.IB2buaDialogExt} message B2buaDialogExt message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            B2buaDialogExt.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a B2buaDialogExt message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.B2buaDialogExt
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.B2buaDialogExt} B2buaDialogExt
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            B2buaDialogExt.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.B2buaDialogExt();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.remoteCSeq = reader.int32();
                            break;
                        }
                    case 2: {
                            message.remoteCSeqIsNull = reader.bool();
                            break;
                        }
                    case 3: {
                            if (!(message.inboundPendingRequests && message.inboundPendingRequests.length))
                                message.inboundPendingRequests = [];
                            message.inboundPendingRequests.push($root.sipjsserver.call.PendingRequest.decode(reader, reader.uint32(), undefined, long + 1));
                            break;
                        }
                    case 4: {
                            message.ackBranch = reader.string();
                            break;
                        }
                    case 5: {
                            message.pendingInviteTxnJson = reader.string();
                            break;
                        }
                    case 6: {
                            message.cachedSdp = reader.bytes();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a B2buaDialogExt message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.B2buaDialogExt
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.B2buaDialogExt} B2buaDialogExt
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
             * @memberof sipjsserver.call.B2buaDialogExt
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            B2buaDialogExt.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
                var properties = {};
                if (message.remoteCSeq != null && message.hasOwnProperty("remoteCSeq")) {
                    properties._remoteCSeq = 1;
                    if (!$util.isInteger(message.remoteCSeq))
                        return "remoteCSeq: integer expected";
                }
                if (message.remoteCSeqIsNull != null && message.hasOwnProperty("remoteCSeqIsNull")) {
                    properties._remoteCSeqIsNull = 1;
                    if (typeof message.remoteCSeqIsNull !== "boolean")
                        return "remoteCSeqIsNull: boolean expected";
                }
                if (message.inboundPendingRequests != null && message.hasOwnProperty("inboundPendingRequests")) {
                    if (!Array.isArray(message.inboundPendingRequests))
                        return "inboundPendingRequests: array expected";
                    for (var i = 0; i < message.inboundPendingRequests.length; ++i) {
                        var error = $root.sipjsserver.call.PendingRequest.verify(message.inboundPendingRequests[i], long + 1);
                        if (error)
                            return "inboundPendingRequests." + error;
                    }
                }
                if (message.ackBranch != null && message.hasOwnProperty("ackBranch")) {
                    properties._ackBranch = 1;
                    if (!$util.isString(message.ackBranch))
                        return "ackBranch: string expected";
                }
                if (message.pendingInviteTxnJson != null && message.hasOwnProperty("pendingInviteTxnJson")) {
                    properties._pendingInviteTxnJson = 1;
                    if (!$util.isString(message.pendingInviteTxnJson))
                        return "pendingInviteTxnJson: string expected";
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
             * @memberof sipjsserver.call.B2buaDialogExt
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.B2buaDialogExt} B2buaDialogExt
             */
            B2buaDialogExt.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.B2buaDialogExt)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.B2buaDialogExt();
                if (object.remoteCSeq != null)
                    message.remoteCSeq = object.remoteCSeq | 0;
                if (object.remoteCSeqIsNull != null)
                    message.remoteCSeqIsNull = Boolean(object.remoteCSeqIsNull);
                if (object.inboundPendingRequests) {
                    if (!Array.isArray(object.inboundPendingRequests))
                        throw TypeError(".sipjsserver.call.B2buaDialogExt.inboundPendingRequests: array expected");
                    message.inboundPendingRequests = [];
                    for (var i = 0; i < object.inboundPendingRequests.length; ++i) {
                        if (typeof object.inboundPendingRequests[i] !== "object")
                            throw TypeError(".sipjsserver.call.B2buaDialogExt.inboundPendingRequests: object expected");
                        message.inboundPendingRequests[i] = $root.sipjsserver.call.PendingRequest.fromObject(object.inboundPendingRequests[i], long + 1);
                    }
                }
                if (object.ackBranch != null)
                    message.ackBranch = String(object.ackBranch);
                if (object.pendingInviteTxnJson != null)
                    message.pendingInviteTxnJson = String(object.pendingInviteTxnJson);
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
             * @memberof sipjsserver.call.B2buaDialogExt
             * @static
             * @param {sipjsserver.call.B2buaDialogExt} message B2buaDialogExt
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            B2buaDialogExt.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                var object = {};
                if (options.arrays || options.defaults)
                    object.inboundPendingRequests = [];
                if (message.remoteCSeq != null && message.hasOwnProperty("remoteCSeq")) {
                    object.remoteCSeq = message.remoteCSeq;
                    if (options.oneofs)
                        object._remoteCSeq = "remoteCSeq";
                }
                if (message.remoteCSeqIsNull != null && message.hasOwnProperty("remoteCSeqIsNull")) {
                    object.remoteCSeqIsNull = message.remoteCSeqIsNull;
                    if (options.oneofs)
                        object._remoteCSeqIsNull = "remoteCSeqIsNull";
                }
                if (message.inboundPendingRequests && message.inboundPendingRequests.length) {
                    object.inboundPendingRequests = [];
                    for (var j = 0; j < message.inboundPendingRequests.length; ++j)
                        object.inboundPendingRequests[j] = $root.sipjsserver.call.PendingRequest.toObject(message.inboundPendingRequests[j], options, q + 1);
                }
                if (message.ackBranch != null && message.hasOwnProperty("ackBranch")) {
                    object.ackBranch = message.ackBranch;
                    if (options.oneofs)
                        object._ackBranch = "ackBranch";
                }
                if (message.pendingInviteTxnJson != null && message.hasOwnProperty("pendingInviteTxnJson")) {
                    object.pendingInviteTxnJson = message.pendingInviteTxnJson;
                    if (options.oneofs)
                        object._pendingInviteTxnJson = "pendingInviteTxnJson";
                }
                if (message.cachedSdp != null && message.hasOwnProperty("cachedSdp")) {
                    object.cachedSdp = options.bytes === String ? $util.base64.encode(message.cachedSdp, 0, message.cachedSdp.length) : options.bytes === Array ? Array.prototype.slice.call(message.cachedSdp) : message.cachedSdp;
                    if (options.oneofs)
                        object._cachedSdp = "cachedSdp";
                }
                return object;
            };

            /**
             * Converts this B2buaDialogExt to JSON.
             * @function toJSON
             * @memberof sipjsserver.call.B2buaDialogExt
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            B2buaDialogExt.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for B2buaDialogExt
             * @function getTypeUrl
             * @memberof sipjsserver.call.B2buaDialogExt
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            B2buaDialogExt.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.B2buaDialogExt";
            };

            return B2buaDialogExt;
        })();

        call.Dialog = (function() {

            /**
             * Properties of a Dialog.
             * @memberof sipjsserver.call
             * @interface IDialog
             * @property {sipjsserver.call.IStackDialog|null} [sip] Dialog sip
             * @property {sipjsserver.call.IB2buaDialogExt|null} [ext] Dialog ext
             */

            /**
             * Constructs a new Dialog.
             * @memberof sipjsserver.call
             * @classdesc Represents a Dialog.
             * @implements IDialog
             * @constructor
             * @param {sipjsserver.call.IDialog=} [properties] Properties to set
             */
            function Dialog(properties) {
                if (properties)
                    for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                        if (properties[keys[i]] != null && keys[i] !== "__proto__")
                            this[keys[i]] = properties[keys[i]];
            }

            /**
             * Dialog sip.
             * @member {sipjsserver.call.IStackDialog|null|undefined} sip
             * @memberof sipjsserver.call.Dialog
             * @instance
             */
            Dialog.prototype.sip = null;

            /**
             * Dialog ext.
             * @member {sipjsserver.call.IB2buaDialogExt|null|undefined} ext
             * @memberof sipjsserver.call.Dialog
             * @instance
             */
            Dialog.prototype.ext = null;

            /**
             * Creates a new Dialog instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.Dialog
             * @static
             * @param {sipjsserver.call.IDialog=} [properties] Properties to set
             * @returns {sipjsserver.call.Dialog} Dialog instance
             */
            Dialog.create = function create(properties) {
                return new Dialog(properties);
            };

            /**
             * Encodes the specified Dialog message. Does not implicitly {@link sipjsserver.call.Dialog.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.Dialog
             * @static
             * @param {sipjsserver.call.IDialog} message Dialog message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            Dialog.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.sip != null && Object.hasOwnProperty.call(message, "sip"))
                    $root.sipjsserver.call.StackDialog.encode(message.sip, writer.uint32(/* id 1, wireType 2 =*/10).fork(), q + 1).ldelim();
                if (message.ext != null && Object.hasOwnProperty.call(message, "ext"))
                    $root.sipjsserver.call.B2buaDialogExt.encode(message.ext, writer.uint32(/* id 2, wireType 2 =*/18).fork(), q + 1).ldelim();
                return writer;
            };

            /**
             * Encodes the specified Dialog message, length delimited. Does not implicitly {@link sipjsserver.call.Dialog.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.Dialog
             * @static
             * @param {sipjsserver.call.IDialog} message Dialog message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            Dialog.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a Dialog message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.Dialog
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.Dialog} Dialog
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            Dialog.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.Dialog();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.sip = $root.sipjsserver.call.StackDialog.decode(reader, reader.uint32(), undefined, long + 1);
                            break;
                        }
                    case 2: {
                            message.ext = $root.sipjsserver.call.B2buaDialogExt.decode(reader, reader.uint32(), undefined, long + 1);
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a Dialog message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.Dialog
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.Dialog} Dialog
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
             * @memberof sipjsserver.call.Dialog
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            Dialog.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
                if (message.sip != null && message.hasOwnProperty("sip")) {
                    var error = $root.sipjsserver.call.StackDialog.verify(message.sip, long + 1);
                    if (error)
                        return "sip." + error;
                }
                if (message.ext != null && message.hasOwnProperty("ext")) {
                    var error = $root.sipjsserver.call.B2buaDialogExt.verify(message.ext, long + 1);
                    if (error)
                        return "ext." + error;
                }
                return null;
            };

            /**
             * Creates a Dialog message from a plain object. Also converts values to their respective internal types.
             * @function fromObject
             * @memberof sipjsserver.call.Dialog
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.Dialog} Dialog
             */
            Dialog.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.Dialog)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.Dialog();
                if (object.sip != null) {
                    if (typeof object.sip !== "object")
                        throw TypeError(".sipjsserver.call.Dialog.sip: object expected");
                    message.sip = $root.sipjsserver.call.StackDialog.fromObject(object.sip, long + 1);
                }
                if (object.ext != null) {
                    if (typeof object.ext !== "object")
                        throw TypeError(".sipjsserver.call.Dialog.ext: object expected");
                    message.ext = $root.sipjsserver.call.B2buaDialogExt.fromObject(object.ext, long + 1);
                }
                return message;
            };

            /**
             * Creates a plain object from a Dialog message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.Dialog
             * @static
             * @param {sipjsserver.call.Dialog} message Dialog
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            Dialog.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                var object = {};
                if (options.defaults) {
                    object.sip = null;
                    object.ext = null;
                }
                if (message.sip != null && message.hasOwnProperty("sip"))
                    object.sip = $root.sipjsserver.call.StackDialog.toObject(message.sip, options, q + 1);
                if (message.ext != null && message.hasOwnProperty("ext"))
                    object.ext = $root.sipjsserver.call.B2buaDialogExt.toObject(message.ext, options, q + 1);
                return object;
            };

            /**
             * Converts this Dialog to JSON.
             * @function toJSON
             * @memberof sipjsserver.call.Dialog
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            Dialog.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for Dialog
             * @function getTypeUrl
             * @memberof sipjsserver.call.Dialog
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            Dialog.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.Dialog";
            };

            return Dialog;
        })();

        call.Leg = (function() {

            /**
             * Properties of a Leg.
             * @memberof sipjsserver.call
             * @interface ILeg
             * @property {string|null} [legId] Leg legId
             * @property {string|null} [callId] Leg callId
             * @property {string|null} [fromTag] Leg fromTag
             * @property {sipjsserver.call.IRemoteInfo|null} [source] Leg source
             * @property {string|null} [state] Leg state
             * @property {string|null} [disposition] Leg disposition
             * @property {Array.<sipjsserver.call.IDialog>|null} [dialogs] Leg dialogs
             * @property {number|null} [noAnswerTimeoutSec] Leg noAnswerTimeoutSec
             * @property {string|null} [byeDisposition] Leg byeDisposition
             * @property {string|null} [localUri] Leg localUri
             * @property {string|null} [remoteUri] Leg remoteUri
             * @property {string|null} [inviteRequestUri] Leg inviteRequestUri
             * @property {string|null} [pendingInviteTxnJson] Leg pendingInviteTxnJson
             * @property {string|null} [extJson] Leg extJson
             */

            /**
             * Constructs a new Leg.
             * @memberof sipjsserver.call
             * @classdesc Represents a Leg.
             * @implements ILeg
             * @constructor
             * @param {sipjsserver.call.ILeg=} [properties] Properties to set
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
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.legId = "";

            /**
             * Leg callId.
             * @member {string} callId
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.callId = "";

            /**
             * Leg fromTag.
             * @member {string} fromTag
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.fromTag = "";

            /**
             * Leg source.
             * @member {sipjsserver.call.IRemoteInfo|null|undefined} source
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.source = null;

            /**
             * Leg state.
             * @member {string} state
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.state = "";

            /**
             * Leg disposition.
             * @member {string} disposition
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.disposition = "";

            /**
             * Leg dialogs.
             * @member {Array.<sipjsserver.call.IDialog>} dialogs
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.dialogs = $util.emptyArray;

            /**
             * Leg noAnswerTimeoutSec.
             * @member {number|null|undefined} noAnswerTimeoutSec
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.noAnswerTimeoutSec = null;

            /**
             * Leg byeDisposition.
             * @member {string|null|undefined} byeDisposition
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.byeDisposition = null;

            /**
             * Leg localUri.
             * @member {string|null|undefined} localUri
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.localUri = null;

            /**
             * Leg remoteUri.
             * @member {string|null|undefined} remoteUri
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.remoteUri = null;

            /**
             * Leg inviteRequestUri.
             * @member {string|null|undefined} inviteRequestUri
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.inviteRequestUri = null;

            /**
             * Leg pendingInviteTxnJson.
             * @member {string|null|undefined} pendingInviteTxnJson
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.pendingInviteTxnJson = null;

            /**
             * Leg extJson.
             * @member {string|null|undefined} extJson
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Leg.prototype.extJson = null;

            // OneOf field names bound to virtual getters and setters
            var $oneOfFields;

            /**
             * Leg _noAnswerTimeoutSec.
             * @member {"noAnswerTimeoutSec"|undefined} _noAnswerTimeoutSec
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Object.defineProperty(Leg.prototype, "_noAnswerTimeoutSec", {
                get: $util.oneOfGetter($oneOfFields = ["noAnswerTimeoutSec"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Leg _byeDisposition.
             * @member {"byeDisposition"|undefined} _byeDisposition
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Object.defineProperty(Leg.prototype, "_byeDisposition", {
                get: $util.oneOfGetter($oneOfFields = ["byeDisposition"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Leg _localUri.
             * @member {"localUri"|undefined} _localUri
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Object.defineProperty(Leg.prototype, "_localUri", {
                get: $util.oneOfGetter($oneOfFields = ["localUri"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Leg _remoteUri.
             * @member {"remoteUri"|undefined} _remoteUri
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Object.defineProperty(Leg.prototype, "_remoteUri", {
                get: $util.oneOfGetter($oneOfFields = ["remoteUri"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Leg _inviteRequestUri.
             * @member {"inviteRequestUri"|undefined} _inviteRequestUri
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Object.defineProperty(Leg.prototype, "_inviteRequestUri", {
                get: $util.oneOfGetter($oneOfFields = ["inviteRequestUri"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Leg _pendingInviteTxnJson.
             * @member {"pendingInviteTxnJson"|undefined} _pendingInviteTxnJson
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Object.defineProperty(Leg.prototype, "_pendingInviteTxnJson", {
                get: $util.oneOfGetter($oneOfFields = ["pendingInviteTxnJson"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Leg _extJson.
             * @member {"extJson"|undefined} _extJson
             * @memberof sipjsserver.call.Leg
             * @instance
             */
            Object.defineProperty(Leg.prototype, "_extJson", {
                get: $util.oneOfGetter($oneOfFields = ["extJson"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Creates a new Leg instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.Leg
             * @static
             * @param {sipjsserver.call.ILeg=} [properties] Properties to set
             * @returns {sipjsserver.call.Leg} Leg instance
             */
            Leg.create = function create(properties) {
                return new Leg(properties);
            };

            /**
             * Encodes the specified Leg message. Does not implicitly {@link sipjsserver.call.Leg.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.Leg
             * @static
             * @param {sipjsserver.call.ILeg} message Leg message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            Leg.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.legId != null && Object.hasOwnProperty.call(message, "legId"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.legId);
                if (message.callId != null && Object.hasOwnProperty.call(message, "callId"))
                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.callId);
                if (message.fromTag != null && Object.hasOwnProperty.call(message, "fromTag"))
                    writer.uint32(/* id 3, wireType 2 =*/26).string(message.fromTag);
                if (message.source != null && Object.hasOwnProperty.call(message, "source"))
                    $root.sipjsserver.call.RemoteInfo.encode(message.source, writer.uint32(/* id 4, wireType 2 =*/34).fork(), q + 1).ldelim();
                if (message.state != null && Object.hasOwnProperty.call(message, "state"))
                    writer.uint32(/* id 5, wireType 2 =*/42).string(message.state);
                if (message.disposition != null && Object.hasOwnProperty.call(message, "disposition"))
                    writer.uint32(/* id 6, wireType 2 =*/50).string(message.disposition);
                if (message.dialogs != null && message.dialogs.length)
                    for (var i = 0; i < message.dialogs.length; ++i)
                        $root.sipjsserver.call.Dialog.encode(message.dialogs[i], writer.uint32(/* id 7, wireType 2 =*/58).fork(), q + 1).ldelim();
                if (message.noAnswerTimeoutSec != null && Object.hasOwnProperty.call(message, "noAnswerTimeoutSec"))
                    writer.uint32(/* id 8, wireType 1 =*/65).double(message.noAnswerTimeoutSec);
                if (message.byeDisposition != null && Object.hasOwnProperty.call(message, "byeDisposition"))
                    writer.uint32(/* id 9, wireType 2 =*/74).string(message.byeDisposition);
                if (message.localUri != null && Object.hasOwnProperty.call(message, "localUri"))
                    writer.uint32(/* id 10, wireType 2 =*/82).string(message.localUri);
                if (message.remoteUri != null && Object.hasOwnProperty.call(message, "remoteUri"))
                    writer.uint32(/* id 11, wireType 2 =*/90).string(message.remoteUri);
                if (message.inviteRequestUri != null && Object.hasOwnProperty.call(message, "inviteRequestUri"))
                    writer.uint32(/* id 12, wireType 2 =*/98).string(message.inviteRequestUri);
                if (message.pendingInviteTxnJson != null && Object.hasOwnProperty.call(message, "pendingInviteTxnJson"))
                    writer.uint32(/* id 13, wireType 2 =*/106).string(message.pendingInviteTxnJson);
                if (message.extJson != null && Object.hasOwnProperty.call(message, "extJson"))
                    writer.uint32(/* id 14, wireType 2 =*/114).string(message.extJson);
                return writer;
            };

            /**
             * Encodes the specified Leg message, length delimited. Does not implicitly {@link sipjsserver.call.Leg.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.Leg
             * @static
             * @param {sipjsserver.call.ILeg} message Leg message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            Leg.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a Leg message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.Leg
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.Leg} Leg
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            Leg.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.Leg();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.legId = reader.string();
                            break;
                        }
                    case 2: {
                            message.callId = reader.string();
                            break;
                        }
                    case 3: {
                            message.fromTag = reader.string();
                            break;
                        }
                    case 4: {
                            message.source = $root.sipjsserver.call.RemoteInfo.decode(reader, reader.uint32(), undefined, long + 1);
                            break;
                        }
                    case 5: {
                            message.state = reader.string();
                            break;
                        }
                    case 6: {
                            message.disposition = reader.string();
                            break;
                        }
                    case 7: {
                            if (!(message.dialogs && message.dialogs.length))
                                message.dialogs = [];
                            message.dialogs.push($root.sipjsserver.call.Dialog.decode(reader, reader.uint32(), undefined, long + 1));
                            break;
                        }
                    case 8: {
                            message.noAnswerTimeoutSec = reader.double();
                            break;
                        }
                    case 9: {
                            message.byeDisposition = reader.string();
                            break;
                        }
                    case 10: {
                            message.localUri = reader.string();
                            break;
                        }
                    case 11: {
                            message.remoteUri = reader.string();
                            break;
                        }
                    case 12: {
                            message.inviteRequestUri = reader.string();
                            break;
                        }
                    case 13: {
                            message.pendingInviteTxnJson = reader.string();
                            break;
                        }
                    case 14: {
                            message.extJson = reader.string();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a Leg message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.Leg
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.Leg} Leg
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
             * @memberof sipjsserver.call.Leg
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            Leg.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
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
                    var error = $root.sipjsserver.call.RemoteInfo.verify(message.source, long + 1);
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
                        var error = $root.sipjsserver.call.Dialog.verify(message.dialogs[i], long + 1);
                        if (error)
                            return "dialogs." + error;
                    }
                }
                if (message.noAnswerTimeoutSec != null && message.hasOwnProperty("noAnswerTimeoutSec")) {
                    properties._noAnswerTimeoutSec = 1;
                    if (typeof message.noAnswerTimeoutSec !== "number")
                        return "noAnswerTimeoutSec: number expected";
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
                if (message.pendingInviteTxnJson != null && message.hasOwnProperty("pendingInviteTxnJson")) {
                    properties._pendingInviteTxnJson = 1;
                    if (!$util.isString(message.pendingInviteTxnJson))
                        return "pendingInviteTxnJson: string expected";
                }
                if (message.extJson != null && message.hasOwnProperty("extJson")) {
                    properties._extJson = 1;
                    if (!$util.isString(message.extJson))
                        return "extJson: string expected";
                }
                return null;
            };

            /**
             * Creates a Leg message from a plain object. Also converts values to their respective internal types.
             * @function fromObject
             * @memberof sipjsserver.call.Leg
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.Leg} Leg
             */
            Leg.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.Leg)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.Leg();
                if (object.legId != null)
                    message.legId = String(object.legId);
                if (object.callId != null)
                    message.callId = String(object.callId);
                if (object.fromTag != null)
                    message.fromTag = String(object.fromTag);
                if (object.source != null) {
                    if (typeof object.source !== "object")
                        throw TypeError(".sipjsserver.call.Leg.source: object expected");
                    message.source = $root.sipjsserver.call.RemoteInfo.fromObject(object.source, long + 1);
                }
                if (object.state != null)
                    message.state = String(object.state);
                if (object.disposition != null)
                    message.disposition = String(object.disposition);
                if (object.dialogs) {
                    if (!Array.isArray(object.dialogs))
                        throw TypeError(".sipjsserver.call.Leg.dialogs: array expected");
                    message.dialogs = [];
                    for (var i = 0; i < object.dialogs.length; ++i) {
                        if (typeof object.dialogs[i] !== "object")
                            throw TypeError(".sipjsserver.call.Leg.dialogs: object expected");
                        message.dialogs[i] = $root.sipjsserver.call.Dialog.fromObject(object.dialogs[i], long + 1);
                    }
                }
                if (object.noAnswerTimeoutSec != null)
                    message.noAnswerTimeoutSec = Number(object.noAnswerTimeoutSec);
                if (object.byeDisposition != null)
                    message.byeDisposition = String(object.byeDisposition);
                if (object.localUri != null)
                    message.localUri = String(object.localUri);
                if (object.remoteUri != null)
                    message.remoteUri = String(object.remoteUri);
                if (object.inviteRequestUri != null)
                    message.inviteRequestUri = String(object.inviteRequestUri);
                if (object.pendingInviteTxnJson != null)
                    message.pendingInviteTxnJson = String(object.pendingInviteTxnJson);
                if (object.extJson != null)
                    message.extJson = String(object.extJson);
                return message;
            };

            /**
             * Creates a plain object from a Leg message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.Leg
             * @static
             * @param {sipjsserver.call.Leg} message Leg
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            Leg.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
                    object.source = $root.sipjsserver.call.RemoteInfo.toObject(message.source, options, q + 1);
                if (message.state != null && message.hasOwnProperty("state"))
                    object.state = message.state;
                if (message.disposition != null && message.hasOwnProperty("disposition"))
                    object.disposition = message.disposition;
                if (message.dialogs && message.dialogs.length) {
                    object.dialogs = [];
                    for (var j = 0; j < message.dialogs.length; ++j)
                        object.dialogs[j] = $root.sipjsserver.call.Dialog.toObject(message.dialogs[j], options, q + 1);
                }
                if (message.noAnswerTimeoutSec != null && message.hasOwnProperty("noAnswerTimeoutSec")) {
                    object.noAnswerTimeoutSec = options.json && !isFinite(message.noAnswerTimeoutSec) ? String(message.noAnswerTimeoutSec) : message.noAnswerTimeoutSec;
                    if (options.oneofs)
                        object._noAnswerTimeoutSec = "noAnswerTimeoutSec";
                }
                if (message.byeDisposition != null && message.hasOwnProperty("byeDisposition")) {
                    object.byeDisposition = message.byeDisposition;
                    if (options.oneofs)
                        object._byeDisposition = "byeDisposition";
                }
                if (message.localUri != null && message.hasOwnProperty("localUri")) {
                    object.localUri = message.localUri;
                    if (options.oneofs)
                        object._localUri = "localUri";
                }
                if (message.remoteUri != null && message.hasOwnProperty("remoteUri")) {
                    object.remoteUri = message.remoteUri;
                    if (options.oneofs)
                        object._remoteUri = "remoteUri";
                }
                if (message.inviteRequestUri != null && message.hasOwnProperty("inviteRequestUri")) {
                    object.inviteRequestUri = message.inviteRequestUri;
                    if (options.oneofs)
                        object._inviteRequestUri = "inviteRequestUri";
                }
                if (message.pendingInviteTxnJson != null && message.hasOwnProperty("pendingInviteTxnJson")) {
                    object.pendingInviteTxnJson = message.pendingInviteTxnJson;
                    if (options.oneofs)
                        object._pendingInviteTxnJson = "pendingInviteTxnJson";
                }
                if (message.extJson != null && message.hasOwnProperty("extJson")) {
                    object.extJson = message.extJson;
                    if (options.oneofs)
                        object._extJson = "extJson";
                }
                return object;
            };

            /**
             * Converts this Leg to JSON.
             * @function toJSON
             * @memberof sipjsserver.call.Leg
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            Leg.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for Leg
             * @function getTypeUrl
             * @memberof sipjsserver.call.Leg
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            Leg.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.Leg";
            };

            return Leg;
        })();

        call.ALegInvite = (function() {

            /**
             * Properties of a ALegInvite.
             * @memberof sipjsserver.call
             * @interface IALegInvite
             * @property {string|null} [uri] ALegInvite uri
             * @property {Array.<sipjsserver.call.ISipHeader>|null} [headers] ALegInvite headers
             * @property {Uint8Array|null} [body] ALegInvite body
             */

            /**
             * Constructs a new ALegInvite.
             * @memberof sipjsserver.call
             * @classdesc Represents a ALegInvite.
             * @implements IALegInvite
             * @constructor
             * @param {sipjsserver.call.IALegInvite=} [properties] Properties to set
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
             * @memberof sipjsserver.call.ALegInvite
             * @instance
             */
            ALegInvite.prototype.uri = "";

            /**
             * ALegInvite headers.
             * @member {Array.<sipjsserver.call.ISipHeader>} headers
             * @memberof sipjsserver.call.ALegInvite
             * @instance
             */
            ALegInvite.prototype.headers = $util.emptyArray;

            /**
             * ALegInvite body.
             * @member {Uint8Array} body
             * @memberof sipjsserver.call.ALegInvite
             * @instance
             */
            ALegInvite.prototype.body = $util.newBuffer([]);

            /**
             * Creates a new ALegInvite instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.ALegInvite
             * @static
             * @param {sipjsserver.call.IALegInvite=} [properties] Properties to set
             * @returns {sipjsserver.call.ALegInvite} ALegInvite instance
             */
            ALegInvite.create = function create(properties) {
                return new ALegInvite(properties);
            };

            /**
             * Encodes the specified ALegInvite message. Does not implicitly {@link sipjsserver.call.ALegInvite.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.ALegInvite
             * @static
             * @param {sipjsserver.call.IALegInvite} message ALegInvite message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            ALegInvite.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.uri != null && Object.hasOwnProperty.call(message, "uri"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.uri);
                if (message.headers != null && message.headers.length)
                    for (var i = 0; i < message.headers.length; ++i)
                        $root.sipjsserver.call.SipHeader.encode(message.headers[i], writer.uint32(/* id 2, wireType 2 =*/18).fork(), q + 1).ldelim();
                if (message.body != null && Object.hasOwnProperty.call(message, "body"))
                    writer.uint32(/* id 3, wireType 2 =*/26).bytes(message.body);
                return writer;
            };

            /**
             * Encodes the specified ALegInvite message, length delimited. Does not implicitly {@link sipjsserver.call.ALegInvite.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.ALegInvite
             * @static
             * @param {sipjsserver.call.IALegInvite} message ALegInvite message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            ALegInvite.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a ALegInvite message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.ALegInvite
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.ALegInvite} ALegInvite
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            ALegInvite.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.ALegInvite();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.uri = reader.string();
                            break;
                        }
                    case 2: {
                            if (!(message.headers && message.headers.length))
                                message.headers = [];
                            message.headers.push($root.sipjsserver.call.SipHeader.decode(reader, reader.uint32(), undefined, long + 1));
                            break;
                        }
                    case 3: {
                            message.body = reader.bytes();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a ALegInvite message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.ALegInvite
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.ALegInvite} ALegInvite
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
             * @memberof sipjsserver.call.ALegInvite
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            ALegInvite.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
                if (message.uri != null && message.hasOwnProperty("uri"))
                    if (!$util.isString(message.uri))
                        return "uri: string expected";
                if (message.headers != null && message.hasOwnProperty("headers")) {
                    if (!Array.isArray(message.headers))
                        return "headers: array expected";
                    for (var i = 0; i < message.headers.length; ++i) {
                        var error = $root.sipjsserver.call.SipHeader.verify(message.headers[i], long + 1);
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
             * @memberof sipjsserver.call.ALegInvite
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.ALegInvite} ALegInvite
             */
            ALegInvite.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.ALegInvite)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.ALegInvite();
                if (object.uri != null)
                    message.uri = String(object.uri);
                if (object.headers) {
                    if (!Array.isArray(object.headers))
                        throw TypeError(".sipjsserver.call.ALegInvite.headers: array expected");
                    message.headers = [];
                    for (var i = 0; i < object.headers.length; ++i) {
                        if (typeof object.headers[i] !== "object")
                            throw TypeError(".sipjsserver.call.ALegInvite.headers: object expected");
                        message.headers[i] = $root.sipjsserver.call.SipHeader.fromObject(object.headers[i], long + 1);
                    }
                }
                if (object.body != null)
                    if (typeof object.body === "string")
                        $util.base64.decode(object.body, message.body = $util.newBuffer($util.base64.length(object.body)), 0);
                    else if (object.body.length >= 0)
                        message.body = object.body;
                return message;
            };

            /**
             * Creates a plain object from a ALegInvite message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.ALegInvite
             * @static
             * @param {sipjsserver.call.ALegInvite} message ALegInvite
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            ALegInvite.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
                    object.headers = [];
                    for (var j = 0; j < message.headers.length; ++j)
                        object.headers[j] = $root.sipjsserver.call.SipHeader.toObject(message.headers[j], options, q + 1);
                }
                if (message.body != null && message.hasOwnProperty("body"))
                    object.body = options.bytes === String ? $util.base64.encode(message.body, 0, message.body.length) : options.bytes === Array ? Array.prototype.slice.call(message.body) : message.body;
                return object;
            };

            /**
             * Converts this ALegInvite to JSON.
             * @function toJSON
             * @memberof sipjsserver.call.ALegInvite
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            ALegInvite.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for ALegInvite
             * @function getTypeUrl
             * @memberof sipjsserver.call.ALegInvite
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            ALegInvite.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.ALegInvite";
            };

            return ALegInvite;
        })();

        call.TagMapping = (function() {

            /**
             * Properties of a TagMapping.
             * @memberof sipjsserver.call
             * @interface ITagMapping
             * @property {string|null} [aTag] TagMapping aTag
             * @property {string|null} [bLegId] TagMapping bLegId
             * @property {string|null} [bTag] TagMapping bTag
             */

            /**
             * Constructs a new TagMapping.
             * @memberof sipjsserver.call
             * @classdesc Represents a TagMapping.
             * @implements ITagMapping
             * @constructor
             * @param {sipjsserver.call.ITagMapping=} [properties] Properties to set
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
             * @memberof sipjsserver.call.TagMapping
             * @instance
             */
            TagMapping.prototype.aTag = "";

            /**
             * TagMapping bLegId.
             * @member {string} bLegId
             * @memberof sipjsserver.call.TagMapping
             * @instance
             */
            TagMapping.prototype.bLegId = "";

            /**
             * TagMapping bTag.
             * @member {string} bTag
             * @memberof sipjsserver.call.TagMapping
             * @instance
             */
            TagMapping.prototype.bTag = "";

            /**
             * Creates a new TagMapping instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.TagMapping
             * @static
             * @param {sipjsserver.call.ITagMapping=} [properties] Properties to set
             * @returns {sipjsserver.call.TagMapping} TagMapping instance
             */
            TagMapping.create = function create(properties) {
                return new TagMapping(properties);
            };

            /**
             * Encodes the specified TagMapping message. Does not implicitly {@link sipjsserver.call.TagMapping.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.TagMapping
             * @static
             * @param {sipjsserver.call.ITagMapping} message TagMapping message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            TagMapping.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.aTag != null && Object.hasOwnProperty.call(message, "aTag"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.aTag);
                if (message.bLegId != null && Object.hasOwnProperty.call(message, "bLegId"))
                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.bLegId);
                if (message.bTag != null && Object.hasOwnProperty.call(message, "bTag"))
                    writer.uint32(/* id 3, wireType 2 =*/26).string(message.bTag);
                return writer;
            };

            /**
             * Encodes the specified TagMapping message, length delimited. Does not implicitly {@link sipjsserver.call.TagMapping.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.TagMapping
             * @static
             * @param {sipjsserver.call.ITagMapping} message TagMapping message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            TagMapping.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a TagMapping message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.TagMapping
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.TagMapping} TagMapping
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            TagMapping.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.TagMapping();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.aTag = reader.string();
                            break;
                        }
                    case 2: {
                            message.bLegId = reader.string();
                            break;
                        }
                    case 3: {
                            message.bTag = reader.string();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a TagMapping message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.TagMapping
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.TagMapping} TagMapping
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
             * @memberof sipjsserver.call.TagMapping
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            TagMapping.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
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
             * @memberof sipjsserver.call.TagMapping
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.TagMapping} TagMapping
             */
            TagMapping.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.TagMapping)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.TagMapping();
                if (object.aTag != null)
                    message.aTag = String(object.aTag);
                if (object.bLegId != null)
                    message.bLegId = String(object.bLegId);
                if (object.bTag != null)
                    message.bTag = String(object.bTag);
                return message;
            };

            /**
             * Creates a plain object from a TagMapping message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.TagMapping
             * @static
             * @param {sipjsserver.call.TagMapping} message TagMapping
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            TagMapping.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
             * @memberof sipjsserver.call.TagMapping
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            TagMapping.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for TagMapping
             * @function getTypeUrl
             * @memberof sipjsserver.call.TagMapping
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            TagMapping.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.TagMapping";
            };

            return TagMapping;
        })();

        call.CallLimiterState = (function() {

            /**
             * Properties of a CallLimiterState.
             * @memberof sipjsserver.call
             * @interface ICallLimiterState
             * @property {string|null} [limiterId] CallLimiterState limiterId
             * @property {number|null} [limit] CallLimiterState limit
             * @property {number|null} [originWindow] CallLimiterState originWindow
             * @property {boolean|null} [incrementSucceeded] CallLimiterState incrementSucceeded
             */

            /**
             * Constructs a new CallLimiterState.
             * @memberof sipjsserver.call
             * @classdesc Represents a CallLimiterState.
             * @implements ICallLimiterState
             * @constructor
             * @param {sipjsserver.call.ICallLimiterState=} [properties] Properties to set
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
             * @memberof sipjsserver.call.CallLimiterState
             * @instance
             */
            CallLimiterState.prototype.limiterId = "";

            /**
             * CallLimiterState limit.
             * @member {number} limit
             * @memberof sipjsserver.call.CallLimiterState
             * @instance
             */
            CallLimiterState.prototype.limit = 0;

            /**
             * CallLimiterState originWindow.
             * @member {number} originWindow
             * @memberof sipjsserver.call.CallLimiterState
             * @instance
             */
            CallLimiterState.prototype.originWindow = 0;

            /**
             * CallLimiterState incrementSucceeded.
             * @member {boolean|null|undefined} incrementSucceeded
             * @memberof sipjsserver.call.CallLimiterState
             * @instance
             */
            CallLimiterState.prototype.incrementSucceeded = null;

            // OneOf field names bound to virtual getters and setters
            var $oneOfFields;

            /**
             * CallLimiterState _incrementSucceeded.
             * @member {"incrementSucceeded"|undefined} _incrementSucceeded
             * @memberof sipjsserver.call.CallLimiterState
             * @instance
             */
            Object.defineProperty(CallLimiterState.prototype, "_incrementSucceeded", {
                get: $util.oneOfGetter($oneOfFields = ["incrementSucceeded"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Creates a new CallLimiterState instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.CallLimiterState
             * @static
             * @param {sipjsserver.call.ICallLimiterState=} [properties] Properties to set
             * @returns {sipjsserver.call.CallLimiterState} CallLimiterState instance
             */
            CallLimiterState.create = function create(properties) {
                return new CallLimiterState(properties);
            };

            /**
             * Encodes the specified CallLimiterState message. Does not implicitly {@link sipjsserver.call.CallLimiterState.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.CallLimiterState
             * @static
             * @param {sipjsserver.call.ICallLimiterState} message CallLimiterState message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            CallLimiterState.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.limiterId != null && Object.hasOwnProperty.call(message, "limiterId"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.limiterId);
                if (message.limit != null && Object.hasOwnProperty.call(message, "limit"))
                    writer.uint32(/* id 2, wireType 0 =*/16).int32(message.limit);
                if (message.originWindow != null && Object.hasOwnProperty.call(message, "originWindow"))
                    writer.uint32(/* id 3, wireType 1 =*/25).double(message.originWindow);
                if (message.incrementSucceeded != null && Object.hasOwnProperty.call(message, "incrementSucceeded"))
                    writer.uint32(/* id 4, wireType 0 =*/32).bool(message.incrementSucceeded);
                return writer;
            };

            /**
             * Encodes the specified CallLimiterState message, length delimited. Does not implicitly {@link sipjsserver.call.CallLimiterState.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.CallLimiterState
             * @static
             * @param {sipjsserver.call.ICallLimiterState} message CallLimiterState message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            CallLimiterState.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a CallLimiterState message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.CallLimiterState
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.CallLimiterState} CallLimiterState
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            CallLimiterState.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.CallLimiterState();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.limiterId = reader.string();
                            break;
                        }
                    case 2: {
                            message.limit = reader.int32();
                            break;
                        }
                    case 3: {
                            message.originWindow = reader.double();
                            break;
                        }
                    case 4: {
                            message.incrementSucceeded = reader.bool();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a CallLimiterState message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.CallLimiterState
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.CallLimiterState} CallLimiterState
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
             * @memberof sipjsserver.call.CallLimiterState
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            CallLimiterState.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
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
             * @memberof sipjsserver.call.CallLimiterState
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.CallLimiterState} CallLimiterState
             */
            CallLimiterState.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.CallLimiterState)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.CallLimiterState();
                if (object.limiterId != null)
                    message.limiterId = String(object.limiterId);
                if (object.limit != null)
                    message.limit = object.limit | 0;
                if (object.originWindow != null)
                    message.originWindow = Number(object.originWindow);
                if (object.incrementSucceeded != null)
                    message.incrementSucceeded = Boolean(object.incrementSucceeded);
                return message;
            };

            /**
             * Creates a plain object from a CallLimiterState message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.CallLimiterState
             * @static
             * @param {sipjsserver.call.CallLimiterState} message CallLimiterState
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            CallLimiterState.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
                if (message.incrementSucceeded != null && message.hasOwnProperty("incrementSucceeded")) {
                    object.incrementSucceeded = message.incrementSucceeded;
                    if (options.oneofs)
                        object._incrementSucceeded = "incrementSucceeded";
                }
                return object;
            };

            /**
             * Converts this CallLimiterState to JSON.
             * @function toJSON
             * @memberof sipjsserver.call.CallLimiterState
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            CallLimiterState.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for CallLimiterState
             * @function getTypeUrl
             * @memberof sipjsserver.call.CallLimiterState
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            CallLimiterState.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.CallLimiterState";
            };

            return CallLimiterState;
        })();

        call.TimerEntry = (function() {

            /**
             * Properties of a TimerEntry.
             * @memberof sipjsserver.call
             * @interface ITimerEntry
             * @property {string|null} [id] TimerEntry id
             * @property {string|null} [type] TimerEntry type
             * @property {number|null} [fireAt] TimerEntry fireAt
             * @property {string|null} [legId] TimerEntry legId
             */

            /**
             * Constructs a new TimerEntry.
             * @memberof sipjsserver.call
             * @classdesc Represents a TimerEntry.
             * @implements ITimerEntry
             * @constructor
             * @param {sipjsserver.call.ITimerEntry=} [properties] Properties to set
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
             * @memberof sipjsserver.call.TimerEntry
             * @instance
             */
            TimerEntry.prototype.id = "";

            /**
             * TimerEntry type.
             * @member {string} type
             * @memberof sipjsserver.call.TimerEntry
             * @instance
             */
            TimerEntry.prototype.type = "";

            /**
             * TimerEntry fireAt.
             * @member {number} fireAt
             * @memberof sipjsserver.call.TimerEntry
             * @instance
             */
            TimerEntry.prototype.fireAt = 0;

            /**
             * TimerEntry legId.
             * @member {string|null|undefined} legId
             * @memberof sipjsserver.call.TimerEntry
             * @instance
             */
            TimerEntry.prototype.legId = null;

            // OneOf field names bound to virtual getters and setters
            var $oneOfFields;

            /**
             * TimerEntry _legId.
             * @member {"legId"|undefined} _legId
             * @memberof sipjsserver.call.TimerEntry
             * @instance
             */
            Object.defineProperty(TimerEntry.prototype, "_legId", {
                get: $util.oneOfGetter($oneOfFields = ["legId"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Creates a new TimerEntry instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.TimerEntry
             * @static
             * @param {sipjsserver.call.ITimerEntry=} [properties] Properties to set
             * @returns {sipjsserver.call.TimerEntry} TimerEntry instance
             */
            TimerEntry.create = function create(properties) {
                return new TimerEntry(properties);
            };

            /**
             * Encodes the specified TimerEntry message. Does not implicitly {@link sipjsserver.call.TimerEntry.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.TimerEntry
             * @static
             * @param {sipjsserver.call.ITimerEntry} message TimerEntry message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            TimerEntry.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.id);
                if (message.type != null && Object.hasOwnProperty.call(message, "type"))
                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.type);
                if (message.fireAt != null && Object.hasOwnProperty.call(message, "fireAt"))
                    writer.uint32(/* id 3, wireType 1 =*/25).double(message.fireAt);
                if (message.legId != null && Object.hasOwnProperty.call(message, "legId"))
                    writer.uint32(/* id 4, wireType 2 =*/34).string(message.legId);
                return writer;
            };

            /**
             * Encodes the specified TimerEntry message, length delimited. Does not implicitly {@link sipjsserver.call.TimerEntry.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.TimerEntry
             * @static
             * @param {sipjsserver.call.ITimerEntry} message TimerEntry message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            TimerEntry.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a TimerEntry message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.TimerEntry
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.TimerEntry} TimerEntry
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            TimerEntry.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.TimerEntry();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.id = reader.string();
                            break;
                        }
                    case 2: {
                            message.type = reader.string();
                            break;
                        }
                    case 3: {
                            message.fireAt = reader.double();
                            break;
                        }
                    case 4: {
                            message.legId = reader.string();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a TimerEntry message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.TimerEntry
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.TimerEntry} TimerEntry
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
             * @memberof sipjsserver.call.TimerEntry
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            TimerEntry.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
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
             * @memberof sipjsserver.call.TimerEntry
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.TimerEntry} TimerEntry
             */
            TimerEntry.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.TimerEntry)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.TimerEntry();
                if (object.id != null)
                    message.id = String(object.id);
                if (object.type != null)
                    message.type = String(object.type);
                if (object.fireAt != null)
                    message.fireAt = Number(object.fireAt);
                if (object.legId != null)
                    message.legId = String(object.legId);
                return message;
            };

            /**
             * Creates a plain object from a TimerEntry message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.TimerEntry
             * @static
             * @param {sipjsserver.call.TimerEntry} message TimerEntry
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            TimerEntry.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
                if (message.legId != null && message.hasOwnProperty("legId")) {
                    object.legId = message.legId;
                    if (options.oneofs)
                        object._legId = "legId";
                }
                return object;
            };

            /**
             * Converts this TimerEntry to JSON.
             * @function toJSON
             * @memberof sipjsserver.call.TimerEntry
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            TimerEntry.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for TimerEntry
             * @function getTypeUrl
             * @memberof sipjsserver.call.TimerEntry
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            TimerEntry.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.TimerEntry";
            };

            return TimerEntry;
        })();

        call.CdrEvent = (function() {

            /**
             * Properties of a CdrEvent.
             * @memberof sipjsserver.call
             * @interface ICdrEvent
             * @property {string|null} [type] CdrEvent type
             * @property {number|null} [timestamp] CdrEvent timestamp
             * @property {string|null} [legId] CdrEvent legId
             * @property {number|null} [statusCode] CdrEvent statusCode
             * @property {string|null} [reason] CdrEvent reason
             */

            /**
             * Constructs a new CdrEvent.
             * @memberof sipjsserver.call
             * @classdesc Represents a CdrEvent.
             * @implements ICdrEvent
             * @constructor
             * @param {sipjsserver.call.ICdrEvent=} [properties] Properties to set
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
             * @memberof sipjsserver.call.CdrEvent
             * @instance
             */
            CdrEvent.prototype.type = "";

            /**
             * CdrEvent timestamp.
             * @member {number} timestamp
             * @memberof sipjsserver.call.CdrEvent
             * @instance
             */
            CdrEvent.prototype.timestamp = 0;

            /**
             * CdrEvent legId.
             * @member {string} legId
             * @memberof sipjsserver.call.CdrEvent
             * @instance
             */
            CdrEvent.prototype.legId = "";

            /**
             * CdrEvent statusCode.
             * @member {number|null|undefined} statusCode
             * @memberof sipjsserver.call.CdrEvent
             * @instance
             */
            CdrEvent.prototype.statusCode = null;

            /**
             * CdrEvent reason.
             * @member {string|null|undefined} reason
             * @memberof sipjsserver.call.CdrEvent
             * @instance
             */
            CdrEvent.prototype.reason = null;

            // OneOf field names bound to virtual getters and setters
            var $oneOfFields;

            /**
             * CdrEvent _statusCode.
             * @member {"statusCode"|undefined} _statusCode
             * @memberof sipjsserver.call.CdrEvent
             * @instance
             */
            Object.defineProperty(CdrEvent.prototype, "_statusCode", {
                get: $util.oneOfGetter($oneOfFields = ["statusCode"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * CdrEvent _reason.
             * @member {"reason"|undefined} _reason
             * @memberof sipjsserver.call.CdrEvent
             * @instance
             */
            Object.defineProperty(CdrEvent.prototype, "_reason", {
                get: $util.oneOfGetter($oneOfFields = ["reason"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Creates a new CdrEvent instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.CdrEvent
             * @static
             * @param {sipjsserver.call.ICdrEvent=} [properties] Properties to set
             * @returns {sipjsserver.call.CdrEvent} CdrEvent instance
             */
            CdrEvent.create = function create(properties) {
                return new CdrEvent(properties);
            };

            /**
             * Encodes the specified CdrEvent message. Does not implicitly {@link sipjsserver.call.CdrEvent.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.CdrEvent
             * @static
             * @param {sipjsserver.call.ICdrEvent} message CdrEvent message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            CdrEvent.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
                return writer;
            };

            /**
             * Encodes the specified CdrEvent message, length delimited. Does not implicitly {@link sipjsserver.call.CdrEvent.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.CdrEvent
             * @static
             * @param {sipjsserver.call.ICdrEvent} message CdrEvent message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            CdrEvent.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a CdrEvent message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.CdrEvent
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.CdrEvent} CdrEvent
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            CdrEvent.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.CdrEvent();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.type = reader.string();
                            break;
                        }
                    case 2: {
                            message.timestamp = reader.double();
                            break;
                        }
                    case 3: {
                            message.legId = reader.string();
                            break;
                        }
                    case 4: {
                            message.statusCode = reader.int32();
                            break;
                        }
                    case 5: {
                            message.reason = reader.string();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a CdrEvent message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.CdrEvent
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.CdrEvent} CdrEvent
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
             * @memberof sipjsserver.call.CdrEvent
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            CdrEvent.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
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
             * @memberof sipjsserver.call.CdrEvent
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.CdrEvent} CdrEvent
             */
            CdrEvent.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.CdrEvent)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.CdrEvent();
                if (object.type != null)
                    message.type = String(object.type);
                if (object.timestamp != null)
                    message.timestamp = Number(object.timestamp);
                if (object.legId != null)
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
             * @memberof sipjsserver.call.CdrEvent
             * @static
             * @param {sipjsserver.call.CdrEvent} message CdrEvent
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            CdrEvent.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
                if (message.statusCode != null && message.hasOwnProperty("statusCode")) {
                    object.statusCode = message.statusCode;
                    if (options.oneofs)
                        object._statusCode = "statusCode";
                }
                if (message.reason != null && message.hasOwnProperty("reason")) {
                    object.reason = message.reason;
                    if (options.oneofs)
                        object._reason = "reason";
                }
                return object;
            };

            /**
             * Converts this CdrEvent to JSON.
             * @function toJSON
             * @memberof sipjsserver.call.CdrEvent
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            CdrEvent.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for CdrEvent
             * @function getTypeUrl
             * @memberof sipjsserver.call.CdrEvent
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            CdrEvent.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.CdrEvent";
            };

            return CdrEvent;
        })();

        call.CallTopology = (function() {

            /**
             * Properties of a CallTopology.
             * @memberof sipjsserver.call
             * @interface ICallTopology
             * @property {string|null} [pri] CallTopology pri
             * @property {string|null} [bak] CallTopology bak
             * @property {number|null} [gen] CallTopology gen
             */

            /**
             * Constructs a new CallTopology.
             * @memberof sipjsserver.call
             * @classdesc Represents a CallTopology.
             * @implements ICallTopology
             * @constructor
             * @param {sipjsserver.call.ICallTopology=} [properties] Properties to set
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
             * @memberof sipjsserver.call.CallTopology
             * @instance
             */
            CallTopology.prototype.pri = "";

            /**
             * CallTopology bak.
             * @member {string} bak
             * @memberof sipjsserver.call.CallTopology
             * @instance
             */
            CallTopology.prototype.bak = "";

            /**
             * CallTopology gen.
             * @member {number} gen
             * @memberof sipjsserver.call.CallTopology
             * @instance
             */
            CallTopology.prototype.gen = 0;

            /**
             * Creates a new CallTopology instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.CallTopology
             * @static
             * @param {sipjsserver.call.ICallTopology=} [properties] Properties to set
             * @returns {sipjsserver.call.CallTopology} CallTopology instance
             */
            CallTopology.create = function create(properties) {
                return new CallTopology(properties);
            };

            /**
             * Encodes the specified CallTopology message. Does not implicitly {@link sipjsserver.call.CallTopology.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.CallTopology
             * @static
             * @param {sipjsserver.call.ICallTopology} message CallTopology message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            CallTopology.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.pri != null && Object.hasOwnProperty.call(message, "pri"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.pri);
                if (message.bak != null && Object.hasOwnProperty.call(message, "bak"))
                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.bak);
                if (message.gen != null && Object.hasOwnProperty.call(message, "gen"))
                    writer.uint32(/* id 3, wireType 0 =*/24).int32(message.gen);
                return writer;
            };

            /**
             * Encodes the specified CallTopology message, length delimited. Does not implicitly {@link sipjsserver.call.CallTopology.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.CallTopology
             * @static
             * @param {sipjsserver.call.ICallTopology} message CallTopology message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            CallTopology.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a CallTopology message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.CallTopology
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.CallTopology} CallTopology
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            CallTopology.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.CallTopology();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.pri = reader.string();
                            break;
                        }
                    case 2: {
                            message.bak = reader.string();
                            break;
                        }
                    case 3: {
                            message.gen = reader.int32();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a CallTopology message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.CallTopology
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.CallTopology} CallTopology
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
             * @memberof sipjsserver.call.CallTopology
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            CallTopology.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
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
             * @memberof sipjsserver.call.CallTopology
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.CallTopology} CallTopology
             */
            CallTopology.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.CallTopology)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.CallTopology();
                if (object.pri != null)
                    message.pri = String(object.pri);
                if (object.bak != null)
                    message.bak = String(object.bak);
                if (object.gen != null)
                    message.gen = object.gen | 0;
                return message;
            };

            /**
             * Creates a plain object from a CallTopology message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.CallTopology
             * @static
             * @param {sipjsserver.call.CallTopology} message CallTopology
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            CallTopology.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
             * @memberof sipjsserver.call.CallTopology
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            CallTopology.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for CallTopology
             * @function getTypeUrl
             * @memberof sipjsserver.call.CallTopology
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            CallTopology.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.CallTopology";
            };

            return CallTopology;
        })();

        call.ActiveRule = (function() {

            /**
             * Properties of an ActiveRule.
             * @memberof sipjsserver.call
             * @interface IActiveRule
             * @property {string|null} [id] ActiveRule id
             * @property {boolean|null} [paramsPresent] ActiveRule paramsPresent
             * @property {string|null} [paramsJson] ActiveRule paramsJson
             * @property {boolean|null} [active] ActiveRule active
             */

            /**
             * Constructs a new ActiveRule.
             * @memberof sipjsserver.call
             * @classdesc Represents an ActiveRule.
             * @implements IActiveRule
             * @constructor
             * @param {sipjsserver.call.IActiveRule=} [properties] Properties to set
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
             * @memberof sipjsserver.call.ActiveRule
             * @instance
             */
            ActiveRule.prototype.id = "";

            /**
             * ActiveRule paramsPresent.
             * @member {boolean} paramsPresent
             * @memberof sipjsserver.call.ActiveRule
             * @instance
             */
            ActiveRule.prototype.paramsPresent = false;

            /**
             * ActiveRule paramsJson.
             * @member {string|null|undefined} paramsJson
             * @memberof sipjsserver.call.ActiveRule
             * @instance
             */
            ActiveRule.prototype.paramsJson = null;

            /**
             * ActiveRule active.
             * @member {boolean} active
             * @memberof sipjsserver.call.ActiveRule
             * @instance
             */
            ActiveRule.prototype.active = false;

            // OneOf field names bound to virtual getters and setters
            var $oneOfFields;

            /**
             * ActiveRule _paramsJson.
             * @member {"paramsJson"|undefined} _paramsJson
             * @memberof sipjsserver.call.ActiveRule
             * @instance
             */
            Object.defineProperty(ActiveRule.prototype, "_paramsJson", {
                get: $util.oneOfGetter($oneOfFields = ["paramsJson"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Creates a new ActiveRule instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.ActiveRule
             * @static
             * @param {sipjsserver.call.IActiveRule=} [properties] Properties to set
             * @returns {sipjsserver.call.ActiveRule} ActiveRule instance
             */
            ActiveRule.create = function create(properties) {
                return new ActiveRule(properties);
            };

            /**
             * Encodes the specified ActiveRule message. Does not implicitly {@link sipjsserver.call.ActiveRule.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.ActiveRule
             * @static
             * @param {sipjsserver.call.IActiveRule} message ActiveRule message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            ActiveRule.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.id != null && Object.hasOwnProperty.call(message, "id"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.id);
                if (message.paramsPresent != null && Object.hasOwnProperty.call(message, "paramsPresent"))
                    writer.uint32(/* id 2, wireType 0 =*/16).bool(message.paramsPresent);
                if (message.paramsJson != null && Object.hasOwnProperty.call(message, "paramsJson"))
                    writer.uint32(/* id 3, wireType 2 =*/26).string(message.paramsJson);
                if (message.active != null && Object.hasOwnProperty.call(message, "active"))
                    writer.uint32(/* id 4, wireType 0 =*/32).bool(message.active);
                return writer;
            };

            /**
             * Encodes the specified ActiveRule message, length delimited. Does not implicitly {@link sipjsserver.call.ActiveRule.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.ActiveRule
             * @static
             * @param {sipjsserver.call.IActiveRule} message ActiveRule message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            ActiveRule.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes an ActiveRule message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.ActiveRule
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.ActiveRule} ActiveRule
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            ActiveRule.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.ActiveRule();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.id = reader.string();
                            break;
                        }
                    case 2: {
                            message.paramsPresent = reader.bool();
                            break;
                        }
                    case 3: {
                            message.paramsJson = reader.string();
                            break;
                        }
                    case 4: {
                            message.active = reader.bool();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes an ActiveRule message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.ActiveRule
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.ActiveRule} ActiveRule
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
             * @memberof sipjsserver.call.ActiveRule
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            ActiveRule.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
                var properties = {};
                if (message.id != null && message.hasOwnProperty("id"))
                    if (!$util.isString(message.id))
                        return "id: string expected";
                if (message.paramsPresent != null && message.hasOwnProperty("paramsPresent"))
                    if (typeof message.paramsPresent !== "boolean")
                        return "paramsPresent: boolean expected";
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
             * @memberof sipjsserver.call.ActiveRule
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.ActiveRule} ActiveRule
             */
            ActiveRule.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.ActiveRule)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.ActiveRule();
                if (object.id != null)
                    message.id = String(object.id);
                if (object.paramsPresent != null)
                    message.paramsPresent = Boolean(object.paramsPresent);
                if (object.paramsJson != null)
                    message.paramsJson = String(object.paramsJson);
                if (object.active != null)
                    message.active = Boolean(object.active);
                return message;
            };

            /**
             * Creates a plain object from an ActiveRule message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.ActiveRule
             * @static
             * @param {sipjsserver.call.ActiveRule} message ActiveRule
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            ActiveRule.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                var object = {};
                if (options.defaults) {
                    object.id = "";
                    object.paramsPresent = false;
                    object.active = false;
                }
                if (message.id != null && message.hasOwnProperty("id"))
                    object.id = message.id;
                if (message.paramsPresent != null && message.hasOwnProperty("paramsPresent"))
                    object.paramsPresent = message.paramsPresent;
                if (message.paramsJson != null && message.hasOwnProperty("paramsJson")) {
                    object.paramsJson = message.paramsJson;
                    if (options.oneofs)
                        object._paramsJson = "paramsJson";
                }
                if (message.active != null && message.hasOwnProperty("active"))
                    object.active = message.active;
                return object;
            };

            /**
             * Converts this ActiveRule to JSON.
             * @function toJSON
             * @memberof sipjsserver.call.ActiveRule
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            ActiveRule.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for ActiveRule
             * @function getTypeUrl
             * @memberof sipjsserver.call.ActiveRule
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            ActiveRule.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.ActiveRule";
            };

            return ActiveRule;
        })();

        call.RuleStateEntry = (function() {

            /**
             * Properties of a RuleStateEntry.
             * @memberof sipjsserver.call
             * @interface IRuleStateEntry
             * @property {string|null} [ruleId] RuleStateEntry ruleId
             * @property {boolean|null} [statePresent] RuleStateEntry statePresent
             * @property {string|null} [stateJson] RuleStateEntry stateJson
             */

            /**
             * Constructs a new RuleStateEntry.
             * @memberof sipjsserver.call
             * @classdesc Represents a RuleStateEntry.
             * @implements IRuleStateEntry
             * @constructor
             * @param {sipjsserver.call.IRuleStateEntry=} [properties] Properties to set
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
             * @memberof sipjsserver.call.RuleStateEntry
             * @instance
             */
            RuleStateEntry.prototype.ruleId = "";

            /**
             * RuleStateEntry statePresent.
             * @member {boolean} statePresent
             * @memberof sipjsserver.call.RuleStateEntry
             * @instance
             */
            RuleStateEntry.prototype.statePresent = false;

            /**
             * RuleStateEntry stateJson.
             * @member {string|null|undefined} stateJson
             * @memberof sipjsserver.call.RuleStateEntry
             * @instance
             */
            RuleStateEntry.prototype.stateJson = null;

            // OneOf field names bound to virtual getters and setters
            var $oneOfFields;

            /**
             * RuleStateEntry _stateJson.
             * @member {"stateJson"|undefined} _stateJson
             * @memberof sipjsserver.call.RuleStateEntry
             * @instance
             */
            Object.defineProperty(RuleStateEntry.prototype, "_stateJson", {
                get: $util.oneOfGetter($oneOfFields = ["stateJson"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Creates a new RuleStateEntry instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.RuleStateEntry
             * @static
             * @param {sipjsserver.call.IRuleStateEntry=} [properties] Properties to set
             * @returns {sipjsserver.call.RuleStateEntry} RuleStateEntry instance
             */
            RuleStateEntry.create = function create(properties) {
                return new RuleStateEntry(properties);
            };

            /**
             * Encodes the specified RuleStateEntry message. Does not implicitly {@link sipjsserver.call.RuleStateEntry.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.RuleStateEntry
             * @static
             * @param {sipjsserver.call.IRuleStateEntry} message RuleStateEntry message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            RuleStateEntry.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.ruleId != null && Object.hasOwnProperty.call(message, "ruleId"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.ruleId);
                if (message.statePresent != null && Object.hasOwnProperty.call(message, "statePresent"))
                    writer.uint32(/* id 2, wireType 0 =*/16).bool(message.statePresent);
                if (message.stateJson != null && Object.hasOwnProperty.call(message, "stateJson"))
                    writer.uint32(/* id 3, wireType 2 =*/26).string(message.stateJson);
                return writer;
            };

            /**
             * Encodes the specified RuleStateEntry message, length delimited. Does not implicitly {@link sipjsserver.call.RuleStateEntry.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.RuleStateEntry
             * @static
             * @param {sipjsserver.call.IRuleStateEntry} message RuleStateEntry message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            RuleStateEntry.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a RuleStateEntry message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.RuleStateEntry
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.RuleStateEntry} RuleStateEntry
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            RuleStateEntry.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.RuleStateEntry();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.ruleId = reader.string();
                            break;
                        }
                    case 2: {
                            message.statePresent = reader.bool();
                            break;
                        }
                    case 3: {
                            message.stateJson = reader.string();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a RuleStateEntry message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.RuleStateEntry
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.RuleStateEntry} RuleStateEntry
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
             * @memberof sipjsserver.call.RuleStateEntry
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            RuleStateEntry.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
                var properties = {};
                if (message.ruleId != null && message.hasOwnProperty("ruleId"))
                    if (!$util.isString(message.ruleId))
                        return "ruleId: string expected";
                if (message.statePresent != null && message.hasOwnProperty("statePresent"))
                    if (typeof message.statePresent !== "boolean")
                        return "statePresent: boolean expected";
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
             * @memberof sipjsserver.call.RuleStateEntry
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.RuleStateEntry} RuleStateEntry
             */
            RuleStateEntry.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.RuleStateEntry)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.RuleStateEntry();
                if (object.ruleId != null)
                    message.ruleId = String(object.ruleId);
                if (object.statePresent != null)
                    message.statePresent = Boolean(object.statePresent);
                if (object.stateJson != null)
                    message.stateJson = String(object.stateJson);
                return message;
            };

            /**
             * Creates a plain object from a RuleStateEntry message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.RuleStateEntry
             * @static
             * @param {sipjsserver.call.RuleStateEntry} message RuleStateEntry
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            RuleStateEntry.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                var object = {};
                if (options.defaults) {
                    object.ruleId = "";
                    object.statePresent = false;
                }
                if (message.ruleId != null && message.hasOwnProperty("ruleId"))
                    object.ruleId = message.ruleId;
                if (message.statePresent != null && message.hasOwnProperty("statePresent"))
                    object.statePresent = message.statePresent;
                if (message.stateJson != null && message.hasOwnProperty("stateJson")) {
                    object.stateJson = message.stateJson;
                    if (options.oneofs)
                        object._stateJson = "stateJson";
                }
                return object;
            };

            /**
             * Converts this RuleStateEntry to JSON.
             * @function toJSON
             * @memberof sipjsserver.call.RuleStateEntry
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            RuleStateEntry.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for RuleStateEntry
             * @function getTypeUrl
             * @memberof sipjsserver.call.RuleStateEntry
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            RuleStateEntry.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.RuleStateEntry";
            };

            return RuleStateEntry;
        })();

        call.ActivePeer = (function() {

            /**
             * Properties of an ActivePeer.
             * @memberof sipjsserver.call
             * @interface IActivePeer
             * @property {string|null} [legA] ActivePeer legA
             * @property {string|null} [legB] ActivePeer legB
             */

            /**
             * Constructs a new ActivePeer.
             * @memberof sipjsserver.call
             * @classdesc Represents an ActivePeer.
             * @implements IActivePeer
             * @constructor
             * @param {sipjsserver.call.IActivePeer=} [properties] Properties to set
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
             * @memberof sipjsserver.call.ActivePeer
             * @instance
             */
            ActivePeer.prototype.legA = "";

            /**
             * ActivePeer legB.
             * @member {string} legB
             * @memberof sipjsserver.call.ActivePeer
             * @instance
             */
            ActivePeer.prototype.legB = "";

            /**
             * Creates a new ActivePeer instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.ActivePeer
             * @static
             * @param {sipjsserver.call.IActivePeer=} [properties] Properties to set
             * @returns {sipjsserver.call.ActivePeer} ActivePeer instance
             */
            ActivePeer.create = function create(properties) {
                return new ActivePeer(properties);
            };

            /**
             * Encodes the specified ActivePeer message. Does not implicitly {@link sipjsserver.call.ActivePeer.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.ActivePeer
             * @static
             * @param {sipjsserver.call.IActivePeer} message ActivePeer message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            ActivePeer.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.legA != null && Object.hasOwnProperty.call(message, "legA"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.legA);
                if (message.legB != null && Object.hasOwnProperty.call(message, "legB"))
                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.legB);
                return writer;
            };

            /**
             * Encodes the specified ActivePeer message, length delimited. Does not implicitly {@link sipjsserver.call.ActivePeer.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.ActivePeer
             * @static
             * @param {sipjsserver.call.IActivePeer} message ActivePeer message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            ActivePeer.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes an ActivePeer message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.ActivePeer
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.ActivePeer} ActivePeer
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            ActivePeer.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.ActivePeer();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.legA = reader.string();
                            break;
                        }
                    case 2: {
                            message.legB = reader.string();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes an ActivePeer message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.ActivePeer
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.ActivePeer} ActivePeer
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
             * @memberof sipjsserver.call.ActivePeer
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            ActivePeer.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
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
             * @memberof sipjsserver.call.ActivePeer
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.ActivePeer} ActivePeer
             */
            ActivePeer.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.ActivePeer)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.ActivePeer();
                if (object.legA != null)
                    message.legA = String(object.legA);
                if (object.legB != null)
                    message.legB = String(object.legB);
                return message;
            };

            /**
             * Creates a plain object from an ActivePeer message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.ActivePeer
             * @static
             * @param {sipjsserver.call.ActivePeer} message ActivePeer
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            ActivePeer.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
             * @memberof sipjsserver.call.ActivePeer
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            ActivePeer.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for ActivePeer
             * @function getTypeUrl
             * @memberof sipjsserver.call.ActivePeer
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            ActivePeer.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.ActivePeer";
            };

            return ActivePeer;
        })();

        call.Call = (function() {

            /**
             * Properties of a Call.
             * @memberof sipjsserver.call
             * @interface ICall
             * @property {string|null} [callRef] Call callRef
             * @property {sipjsserver.call.ILeg|null} [aLeg] Call aLeg
             * @property {Array.<sipjsserver.call.ILeg>|null} [bLegs] Call bLegs
             * @property {sipjsserver.call.IActivePeer|null} [activePeer] Call activePeer
             * @property {boolean|null} [activePeerIsNull] Call activePeerIsNull
             * @property {string|null} [callbackContext] Call callbackContext
             * @property {string|null} [billingContext] Call billingContext
             * @property {boolean|null} [billingContextIsNull] Call billingContextIsNull
             * @property {sipjsserver.call.IALegInvite|null} [aLegInvite] Call aLegInvite
             * @property {Array.<sipjsserver.call.ICallLimiterState>|null} [limiterEntries] Call limiterEntries
             * @property {Array.<sipjsserver.call.ITimerEntry>|null} [timers] Call timers
             * @property {Array.<sipjsserver.call.ICdrEvent>|null} [cdrEvents] Call cdrEvents
             * @property {string|null} [state] Call state
             * @property {number|null} [createdAt] Call createdAt
             * @property {Array.<string>|null} [aLegPendingVias] Call aLegPendingVias
             * @property {boolean|null} [aLegPendingViasPresent] Call aLegPendingViasPresent
             * @property {number|null} [aLegPendingCSeq] Call aLegPendingCSeq
             * @property {Array.<sipjsserver.call.ITagMapping>|null} [tagMap] Call tagMap
             * @property {string|null} [traceId] Call traceId
             * @property {string|null} [rootSpanId] Call rootSpanId
             * @property {boolean|null} [sampled] Call sampled
             * @property {number|null} [workerIndex] Call workerIndex
             * @property {sipjsserver.call.ICallTopology|null} [topology] Call topology
             * @property {boolean|null} [emergency] Call emergency
             * @property {string|null} [featuresJson] Call featuresJson
             * @property {string|null} [policyUpdateHeadersJson] Call policyUpdateHeadersJson
             * @property {Uint8Array|null} [policyUpdateBody] Call policyUpdateBody
             * @property {boolean|null} [policyUpdateBodyIsNull] Call policyUpdateBodyIsNull
             * @property {Array.<sipjsserver.call.IActiveRule>|null} [activeRules] Call activeRules
             * @property {boolean|null} [activeRulesPresent] Call activeRulesPresent
             * @property {Array.<sipjsserver.call.IRuleStateEntry>|null} [ruleState] Call ruleState
             * @property {boolean|null} [ruleStatePresent] Call ruleStatePresent
             * @property {number|null} [messageCount] Call messageCount
             * @property {Array.<string>|null} [terminatingRefreshLegs] Call terminatingRefreshLegs
             * @property {boolean|null} [terminatingRefreshLegsPresent] Call terminatingRefreshLegsPresent
             * @property {string|null} [extJson] Call extJson
             */

            /**
             * Constructs a new Call.
             * @memberof sipjsserver.call
             * @classdesc Represents a Call.
             * @implements ICall
             * @constructor
             * @param {sipjsserver.call.ICall=} [properties] Properties to set
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
                this.terminatingRefreshLegs = [];
                if (properties)
                    for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                        if (properties[keys[i]] != null && keys[i] !== "__proto__")
                            this[keys[i]] = properties[keys[i]];
            }

            /**
             * Call callRef.
             * @member {string} callRef
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.callRef = "";

            /**
             * Call aLeg.
             * @member {sipjsserver.call.ILeg|null|undefined} aLeg
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.aLeg = null;

            /**
             * Call bLegs.
             * @member {Array.<sipjsserver.call.ILeg>} bLegs
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.bLegs = $util.emptyArray;

            /**
             * Call activePeer.
             * @member {sipjsserver.call.IActivePeer|null|undefined} activePeer
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.activePeer = null;

            /**
             * Call activePeerIsNull.
             * @member {boolean} activePeerIsNull
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.activePeerIsNull = false;

            /**
             * Call callbackContext.
             * @member {string|null|undefined} callbackContext
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.callbackContext = null;

            /**
             * Call billingContext.
             * @member {string|null|undefined} billingContext
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.billingContext = null;

            /**
             * Call billingContextIsNull.
             * @member {boolean|null|undefined} billingContextIsNull
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.billingContextIsNull = null;

            /**
             * Call aLegInvite.
             * @member {sipjsserver.call.IALegInvite|null|undefined} aLegInvite
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.aLegInvite = null;

            /**
             * Call limiterEntries.
             * @member {Array.<sipjsserver.call.ICallLimiterState>} limiterEntries
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.limiterEntries = $util.emptyArray;

            /**
             * Call timers.
             * @member {Array.<sipjsserver.call.ITimerEntry>} timers
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.timers = $util.emptyArray;

            /**
             * Call cdrEvents.
             * @member {Array.<sipjsserver.call.ICdrEvent>} cdrEvents
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.cdrEvents = $util.emptyArray;

            /**
             * Call state.
             * @member {string} state
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.state = "";

            /**
             * Call createdAt.
             * @member {number} createdAt
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.createdAt = 0;

            /**
             * Call aLegPendingVias.
             * @member {Array.<string>} aLegPendingVias
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.aLegPendingVias = $util.emptyArray;

            /**
             * Call aLegPendingViasPresent.
             * @member {boolean} aLegPendingViasPresent
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.aLegPendingViasPresent = false;

            /**
             * Call aLegPendingCSeq.
             * @member {number|null|undefined} aLegPendingCSeq
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.aLegPendingCSeq = null;

            /**
             * Call tagMap.
             * @member {Array.<sipjsserver.call.ITagMapping>} tagMap
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.tagMap = $util.emptyArray;

            /**
             * Call traceId.
             * @member {string|null|undefined} traceId
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.traceId = null;

            /**
             * Call rootSpanId.
             * @member {string|null|undefined} rootSpanId
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.rootSpanId = null;

            /**
             * Call sampled.
             * @member {boolean|null|undefined} sampled
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.sampled = null;

            /**
             * Call workerIndex.
             * @member {number|null|undefined} workerIndex
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.workerIndex = null;

            /**
             * Call topology.
             * @member {sipjsserver.call.ICallTopology|null|undefined} topology
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.topology = null;

            /**
             * Call emergency.
             * @member {boolean|null|undefined} emergency
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.emergency = null;

            /**
             * Call featuresJson.
             * @member {string|null|undefined} featuresJson
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.featuresJson = null;

            /**
             * Call policyUpdateHeadersJson.
             * @member {string|null|undefined} policyUpdateHeadersJson
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.policyUpdateHeadersJson = null;

            /**
             * Call policyUpdateBody.
             * @member {Uint8Array|null|undefined} policyUpdateBody
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.policyUpdateBody = null;

            /**
             * Call policyUpdateBodyIsNull.
             * @member {boolean|null|undefined} policyUpdateBodyIsNull
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.policyUpdateBodyIsNull = null;

            /**
             * Call activeRules.
             * @member {Array.<sipjsserver.call.IActiveRule>} activeRules
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.activeRules = $util.emptyArray;

            /**
             * Call activeRulesPresent.
             * @member {boolean} activeRulesPresent
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.activeRulesPresent = false;

            /**
             * Call ruleState.
             * @member {Array.<sipjsserver.call.IRuleStateEntry>} ruleState
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.ruleState = $util.emptyArray;

            /**
             * Call ruleStatePresent.
             * @member {boolean} ruleStatePresent
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.ruleStatePresent = false;

            /**
             * Call messageCount.
             * @member {number|null|undefined} messageCount
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.messageCount = null;

            /**
             * Call terminatingRefreshLegs.
             * @member {Array.<string>} terminatingRefreshLegs
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.terminatingRefreshLegs = $util.emptyArray;

            /**
             * Call terminatingRefreshLegsPresent.
             * @member {boolean} terminatingRefreshLegsPresent
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.terminatingRefreshLegsPresent = false;

            /**
             * Call extJson.
             * @member {string|null|undefined} extJson
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Call.prototype.extJson = null;

            // OneOf field names bound to virtual getters and setters
            var $oneOfFields;

            /**
             * Call _activePeer.
             * @member {"activePeer"|undefined} _activePeer
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_activePeer", {
                get: $util.oneOfGetter($oneOfFields = ["activePeer"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _callbackContext.
             * @member {"callbackContext"|undefined} _callbackContext
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_callbackContext", {
                get: $util.oneOfGetter($oneOfFields = ["callbackContext"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _billingContext.
             * @member {"billingContext"|undefined} _billingContext
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_billingContext", {
                get: $util.oneOfGetter($oneOfFields = ["billingContext"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _billingContextIsNull.
             * @member {"billingContextIsNull"|undefined} _billingContextIsNull
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_billingContextIsNull", {
                get: $util.oneOfGetter($oneOfFields = ["billingContextIsNull"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _aLegPendingCSeq.
             * @member {"aLegPendingCSeq"|undefined} _aLegPendingCSeq
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_aLegPendingCSeq", {
                get: $util.oneOfGetter($oneOfFields = ["aLegPendingCSeq"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _traceId.
             * @member {"traceId"|undefined} _traceId
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_traceId", {
                get: $util.oneOfGetter($oneOfFields = ["traceId"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _rootSpanId.
             * @member {"rootSpanId"|undefined} _rootSpanId
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_rootSpanId", {
                get: $util.oneOfGetter($oneOfFields = ["rootSpanId"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _sampled.
             * @member {"sampled"|undefined} _sampled
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_sampled", {
                get: $util.oneOfGetter($oneOfFields = ["sampled"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _workerIndex.
             * @member {"workerIndex"|undefined} _workerIndex
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_workerIndex", {
                get: $util.oneOfGetter($oneOfFields = ["workerIndex"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _topology.
             * @member {"topology"|undefined} _topology
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_topology", {
                get: $util.oneOfGetter($oneOfFields = ["topology"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _emergency.
             * @member {"emergency"|undefined} _emergency
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_emergency", {
                get: $util.oneOfGetter($oneOfFields = ["emergency"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _featuresJson.
             * @member {"featuresJson"|undefined} _featuresJson
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_featuresJson", {
                get: $util.oneOfGetter($oneOfFields = ["featuresJson"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _policyUpdateHeadersJson.
             * @member {"policyUpdateHeadersJson"|undefined} _policyUpdateHeadersJson
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_policyUpdateHeadersJson", {
                get: $util.oneOfGetter($oneOfFields = ["policyUpdateHeadersJson"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _policyUpdateBody.
             * @member {"policyUpdateBody"|undefined} _policyUpdateBody
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_policyUpdateBody", {
                get: $util.oneOfGetter($oneOfFields = ["policyUpdateBody"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _policyUpdateBodyIsNull.
             * @member {"policyUpdateBodyIsNull"|undefined} _policyUpdateBodyIsNull
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_policyUpdateBodyIsNull", {
                get: $util.oneOfGetter($oneOfFields = ["policyUpdateBodyIsNull"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _messageCount.
             * @member {"messageCount"|undefined} _messageCount
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_messageCount", {
                get: $util.oneOfGetter($oneOfFields = ["messageCount"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Call _extJson.
             * @member {"extJson"|undefined} _extJson
             * @memberof sipjsserver.call.Call
             * @instance
             */
            Object.defineProperty(Call.prototype, "_extJson", {
                get: $util.oneOfGetter($oneOfFields = ["extJson"]),
                set: $util.oneOfSetter($oneOfFields)
            });

            /**
             * Creates a new Call instance using the specified properties.
             * @function create
             * @memberof sipjsserver.call.Call
             * @static
             * @param {sipjsserver.call.ICall=} [properties] Properties to set
             * @returns {sipjsserver.call.Call} Call instance
             */
            Call.create = function create(properties) {
                return new Call(properties);
            };

            /**
             * Encodes the specified Call message. Does not implicitly {@link sipjsserver.call.Call.verify|verify} messages.
             * @function encode
             * @memberof sipjsserver.call.Call
             * @static
             * @param {sipjsserver.call.ICall} message Call message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            Call.encode = function encode(message, writer, q) {
                if (!writer)
                    writer = $Writer.create();
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
                    throw Error("max depth exceeded");
                if (message.callRef != null && Object.hasOwnProperty.call(message, "callRef"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.callRef);
                if (message.aLeg != null && Object.hasOwnProperty.call(message, "aLeg"))
                    $root.sipjsserver.call.Leg.encode(message.aLeg, writer.uint32(/* id 2, wireType 2 =*/18).fork(), q + 1).ldelim();
                if (message.bLegs != null && message.bLegs.length)
                    for (var i = 0; i < message.bLegs.length; ++i)
                        $root.sipjsserver.call.Leg.encode(message.bLegs[i], writer.uint32(/* id 3, wireType 2 =*/26).fork(), q + 1).ldelim();
                if (message.activePeer != null && Object.hasOwnProperty.call(message, "activePeer"))
                    $root.sipjsserver.call.ActivePeer.encode(message.activePeer, writer.uint32(/* id 4, wireType 2 =*/34).fork(), q + 1).ldelim();
                if (message.activePeerIsNull != null && Object.hasOwnProperty.call(message, "activePeerIsNull"))
                    writer.uint32(/* id 5, wireType 0 =*/40).bool(message.activePeerIsNull);
                if (message.callbackContext != null && Object.hasOwnProperty.call(message, "callbackContext"))
                    writer.uint32(/* id 6, wireType 2 =*/50).string(message.callbackContext);
                if (message.billingContext != null && Object.hasOwnProperty.call(message, "billingContext"))
                    writer.uint32(/* id 7, wireType 2 =*/58).string(message.billingContext);
                if (message.billingContextIsNull != null && Object.hasOwnProperty.call(message, "billingContextIsNull"))
                    writer.uint32(/* id 8, wireType 0 =*/64).bool(message.billingContextIsNull);
                if (message.aLegInvite != null && Object.hasOwnProperty.call(message, "aLegInvite"))
                    $root.sipjsserver.call.ALegInvite.encode(message.aLegInvite, writer.uint32(/* id 9, wireType 2 =*/74).fork(), q + 1).ldelim();
                if (message.limiterEntries != null && message.limiterEntries.length)
                    for (var i = 0; i < message.limiterEntries.length; ++i)
                        $root.sipjsserver.call.CallLimiterState.encode(message.limiterEntries[i], writer.uint32(/* id 10, wireType 2 =*/82).fork(), q + 1).ldelim();
                if (message.timers != null && message.timers.length)
                    for (var i = 0; i < message.timers.length; ++i)
                        $root.sipjsserver.call.TimerEntry.encode(message.timers[i], writer.uint32(/* id 11, wireType 2 =*/90).fork(), q + 1).ldelim();
                if (message.cdrEvents != null && message.cdrEvents.length)
                    for (var i = 0; i < message.cdrEvents.length; ++i)
                        $root.sipjsserver.call.CdrEvent.encode(message.cdrEvents[i], writer.uint32(/* id 12, wireType 2 =*/98).fork(), q + 1).ldelim();
                if (message.state != null && Object.hasOwnProperty.call(message, "state"))
                    writer.uint32(/* id 13, wireType 2 =*/106).string(message.state);
                if (message.createdAt != null && Object.hasOwnProperty.call(message, "createdAt"))
                    writer.uint32(/* id 14, wireType 1 =*/113).double(message.createdAt);
                if (message.aLegPendingVias != null && message.aLegPendingVias.length)
                    for (var i = 0; i < message.aLegPendingVias.length; ++i)
                        writer.uint32(/* id 15, wireType 2 =*/122).string(message.aLegPendingVias[i]);
                if (message.aLegPendingViasPresent != null && Object.hasOwnProperty.call(message, "aLegPendingViasPresent"))
                    writer.uint32(/* id 16, wireType 0 =*/128).bool(message.aLegPendingViasPresent);
                if (message.aLegPendingCSeq != null && Object.hasOwnProperty.call(message, "aLegPendingCSeq"))
                    writer.uint32(/* id 17, wireType 0 =*/136).int32(message.aLegPendingCSeq);
                if (message.tagMap != null && message.tagMap.length)
                    for (var i = 0; i < message.tagMap.length; ++i)
                        $root.sipjsserver.call.TagMapping.encode(message.tagMap[i], writer.uint32(/* id 18, wireType 2 =*/146).fork(), q + 1).ldelim();
                if (message.traceId != null && Object.hasOwnProperty.call(message, "traceId"))
                    writer.uint32(/* id 19, wireType 2 =*/154).string(message.traceId);
                if (message.rootSpanId != null && Object.hasOwnProperty.call(message, "rootSpanId"))
                    writer.uint32(/* id 20, wireType 2 =*/162).string(message.rootSpanId);
                if (message.sampled != null && Object.hasOwnProperty.call(message, "sampled"))
                    writer.uint32(/* id 21, wireType 0 =*/168).bool(message.sampled);
                if (message.workerIndex != null && Object.hasOwnProperty.call(message, "workerIndex"))
                    writer.uint32(/* id 22, wireType 0 =*/176).int32(message.workerIndex);
                if (message.topology != null && Object.hasOwnProperty.call(message, "topology"))
                    $root.sipjsserver.call.CallTopology.encode(message.topology, writer.uint32(/* id 23, wireType 2 =*/186).fork(), q + 1).ldelim();
                if (message.emergency != null && Object.hasOwnProperty.call(message, "emergency"))
                    writer.uint32(/* id 24, wireType 0 =*/192).bool(message.emergency);
                if (message.featuresJson != null && Object.hasOwnProperty.call(message, "featuresJson"))
                    writer.uint32(/* id 25, wireType 2 =*/202).string(message.featuresJson);
                if (message.policyUpdateHeadersJson != null && Object.hasOwnProperty.call(message, "policyUpdateHeadersJson"))
                    writer.uint32(/* id 26, wireType 2 =*/210).string(message.policyUpdateHeadersJson);
                if (message.policyUpdateBody != null && Object.hasOwnProperty.call(message, "policyUpdateBody"))
                    writer.uint32(/* id 27, wireType 2 =*/218).bytes(message.policyUpdateBody);
                if (message.policyUpdateBodyIsNull != null && Object.hasOwnProperty.call(message, "policyUpdateBodyIsNull"))
                    writer.uint32(/* id 28, wireType 0 =*/224).bool(message.policyUpdateBodyIsNull);
                if (message.activeRules != null && message.activeRules.length)
                    for (var i = 0; i < message.activeRules.length; ++i)
                        $root.sipjsserver.call.ActiveRule.encode(message.activeRules[i], writer.uint32(/* id 29, wireType 2 =*/234).fork(), q + 1).ldelim();
                if (message.activeRulesPresent != null && Object.hasOwnProperty.call(message, "activeRulesPresent"))
                    writer.uint32(/* id 30, wireType 0 =*/240).bool(message.activeRulesPresent);
                if (message.ruleState != null && message.ruleState.length)
                    for (var i = 0; i < message.ruleState.length; ++i)
                        $root.sipjsserver.call.RuleStateEntry.encode(message.ruleState[i], writer.uint32(/* id 31, wireType 2 =*/250).fork(), q + 1).ldelim();
                if (message.ruleStatePresent != null && Object.hasOwnProperty.call(message, "ruleStatePresent"))
                    writer.uint32(/* id 32, wireType 0 =*/256).bool(message.ruleStatePresent);
                if (message.messageCount != null && Object.hasOwnProperty.call(message, "messageCount"))
                    writer.uint32(/* id 37, wireType 0 =*/296).int32(message.messageCount);
                if (message.terminatingRefreshLegs != null && message.terminatingRefreshLegs.length)
                    for (var i = 0; i < message.terminatingRefreshLegs.length; ++i)
                        writer.uint32(/* id 38, wireType 2 =*/306).string(message.terminatingRefreshLegs[i]);
                if (message.terminatingRefreshLegsPresent != null && Object.hasOwnProperty.call(message, "terminatingRefreshLegsPresent"))
                    writer.uint32(/* id 39, wireType 0 =*/312).bool(message.terminatingRefreshLegsPresent);
                if (message.extJson != null && Object.hasOwnProperty.call(message, "extJson"))
                    writer.uint32(/* id 40, wireType 2 =*/322).string(message.extJson);
                return writer;
            };

            /**
             * Encodes the specified Call message, length delimited. Does not implicitly {@link sipjsserver.call.Call.verify|verify} messages.
             * @function encodeDelimited
             * @memberof sipjsserver.call.Call
             * @static
             * @param {sipjsserver.call.ICall} message Call message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            Call.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a Call message from the specified reader or buffer.
             * @function decode
             * @memberof sipjsserver.call.Call
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {sipjsserver.call.Call} Call
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            Call.decode = function decode(reader, length, error, long) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (long === undefined)
                    long = 0;
                if (long > $Reader.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.sipjsserver.call.Call();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.callRef = reader.string();
                            break;
                        }
                    case 2: {
                            message.aLeg = $root.sipjsserver.call.Leg.decode(reader, reader.uint32(), undefined, long + 1);
                            break;
                        }
                    case 3: {
                            if (!(message.bLegs && message.bLegs.length))
                                message.bLegs = [];
                            message.bLegs.push($root.sipjsserver.call.Leg.decode(reader, reader.uint32(), undefined, long + 1));
                            break;
                        }
                    case 4: {
                            message.activePeer = $root.sipjsserver.call.ActivePeer.decode(reader, reader.uint32(), undefined, long + 1);
                            break;
                        }
                    case 5: {
                            message.activePeerIsNull = reader.bool();
                            break;
                        }
                    case 6: {
                            message.callbackContext = reader.string();
                            break;
                        }
                    case 7: {
                            message.billingContext = reader.string();
                            break;
                        }
                    case 8: {
                            message.billingContextIsNull = reader.bool();
                            break;
                        }
                    case 9: {
                            message.aLegInvite = $root.sipjsserver.call.ALegInvite.decode(reader, reader.uint32(), undefined, long + 1);
                            break;
                        }
                    case 10: {
                            if (!(message.limiterEntries && message.limiterEntries.length))
                                message.limiterEntries = [];
                            message.limiterEntries.push($root.sipjsserver.call.CallLimiterState.decode(reader, reader.uint32(), undefined, long + 1));
                            break;
                        }
                    case 11: {
                            if (!(message.timers && message.timers.length))
                                message.timers = [];
                            message.timers.push($root.sipjsserver.call.TimerEntry.decode(reader, reader.uint32(), undefined, long + 1));
                            break;
                        }
                    case 12: {
                            if (!(message.cdrEvents && message.cdrEvents.length))
                                message.cdrEvents = [];
                            message.cdrEvents.push($root.sipjsserver.call.CdrEvent.decode(reader, reader.uint32(), undefined, long + 1));
                            break;
                        }
                    case 13: {
                            message.state = reader.string();
                            break;
                        }
                    case 14: {
                            message.createdAt = reader.double();
                            break;
                        }
                    case 15: {
                            if (!(message.aLegPendingVias && message.aLegPendingVias.length))
                                message.aLegPendingVias = [];
                            message.aLegPendingVias.push(reader.string());
                            break;
                        }
                    case 16: {
                            message.aLegPendingViasPresent = reader.bool();
                            break;
                        }
                    case 17: {
                            message.aLegPendingCSeq = reader.int32();
                            break;
                        }
                    case 18: {
                            if (!(message.tagMap && message.tagMap.length))
                                message.tagMap = [];
                            message.tagMap.push($root.sipjsserver.call.TagMapping.decode(reader, reader.uint32(), undefined, long + 1));
                            break;
                        }
                    case 19: {
                            message.traceId = reader.string();
                            break;
                        }
                    case 20: {
                            message.rootSpanId = reader.string();
                            break;
                        }
                    case 21: {
                            message.sampled = reader.bool();
                            break;
                        }
                    case 22: {
                            message.workerIndex = reader.int32();
                            break;
                        }
                    case 23: {
                            message.topology = $root.sipjsserver.call.CallTopology.decode(reader, reader.uint32(), undefined, long + 1);
                            break;
                        }
                    case 24: {
                            message.emergency = reader.bool();
                            break;
                        }
                    case 25: {
                            message.featuresJson = reader.string();
                            break;
                        }
                    case 26: {
                            message.policyUpdateHeadersJson = reader.string();
                            break;
                        }
                    case 27: {
                            message.policyUpdateBody = reader.bytes();
                            break;
                        }
                    case 28: {
                            message.policyUpdateBodyIsNull = reader.bool();
                            break;
                        }
                    case 29: {
                            if (!(message.activeRules && message.activeRules.length))
                                message.activeRules = [];
                            message.activeRules.push($root.sipjsserver.call.ActiveRule.decode(reader, reader.uint32(), undefined, long + 1));
                            break;
                        }
                    case 30: {
                            message.activeRulesPresent = reader.bool();
                            break;
                        }
                    case 31: {
                            if (!(message.ruleState && message.ruleState.length))
                                message.ruleState = [];
                            message.ruleState.push($root.sipjsserver.call.RuleStateEntry.decode(reader, reader.uint32(), undefined, long + 1));
                            break;
                        }
                    case 32: {
                            message.ruleStatePresent = reader.bool();
                            break;
                        }
                    case 37: {
                            message.messageCount = reader.int32();
                            break;
                        }
                    case 38: {
                            if (!(message.terminatingRefreshLegs && message.terminatingRefreshLegs.length))
                                message.terminatingRefreshLegs = [];
                            message.terminatingRefreshLegs.push(reader.string());
                            break;
                        }
                    case 39: {
                            message.terminatingRefreshLegsPresent = reader.bool();
                            break;
                        }
                    case 40: {
                            message.extJson = reader.string();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7, long);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a Call message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof sipjsserver.call.Call
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {sipjsserver.call.Call} Call
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
             * @memberof sipjsserver.call.Call
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            Call.verify = function verify(message, long) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    return "maximum nesting depth exceeded";
                var properties = {};
                if (message.callRef != null && message.hasOwnProperty("callRef"))
                    if (!$util.isString(message.callRef))
                        return "callRef: string expected";
                if (message.aLeg != null && message.hasOwnProperty("aLeg")) {
                    var error = $root.sipjsserver.call.Leg.verify(message.aLeg, long + 1);
                    if (error)
                        return "aLeg." + error;
                }
                if (message.bLegs != null && message.hasOwnProperty("bLegs")) {
                    if (!Array.isArray(message.bLegs))
                        return "bLegs: array expected";
                    for (var i = 0; i < message.bLegs.length; ++i) {
                        var error = $root.sipjsserver.call.Leg.verify(message.bLegs[i], long + 1);
                        if (error)
                            return "bLegs." + error;
                    }
                }
                if (message.activePeer != null && message.hasOwnProperty("activePeer")) {
                    properties._activePeer = 1;
                    {
                        var error = $root.sipjsserver.call.ActivePeer.verify(message.activePeer, long + 1);
                        if (error)
                            return "activePeer." + error;
                    }
                }
                if (message.activePeerIsNull != null && message.hasOwnProperty("activePeerIsNull"))
                    if (typeof message.activePeerIsNull !== "boolean")
                        return "activePeerIsNull: boolean expected";
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
                if (message.billingContextIsNull != null && message.hasOwnProperty("billingContextIsNull")) {
                    properties._billingContextIsNull = 1;
                    if (typeof message.billingContextIsNull !== "boolean")
                        return "billingContextIsNull: boolean expected";
                }
                if (message.aLegInvite != null && message.hasOwnProperty("aLegInvite")) {
                    var error = $root.sipjsserver.call.ALegInvite.verify(message.aLegInvite, long + 1);
                    if (error)
                        return "aLegInvite." + error;
                }
                if (message.limiterEntries != null && message.hasOwnProperty("limiterEntries")) {
                    if (!Array.isArray(message.limiterEntries))
                        return "limiterEntries: array expected";
                    for (var i = 0; i < message.limiterEntries.length; ++i) {
                        var error = $root.sipjsserver.call.CallLimiterState.verify(message.limiterEntries[i], long + 1);
                        if (error)
                            return "limiterEntries." + error;
                    }
                }
                if (message.timers != null && message.hasOwnProperty("timers")) {
                    if (!Array.isArray(message.timers))
                        return "timers: array expected";
                    for (var i = 0; i < message.timers.length; ++i) {
                        var error = $root.sipjsserver.call.TimerEntry.verify(message.timers[i], long + 1);
                        if (error)
                            return "timers." + error;
                    }
                }
                if (message.cdrEvents != null && message.hasOwnProperty("cdrEvents")) {
                    if (!Array.isArray(message.cdrEvents))
                        return "cdrEvents: array expected";
                    for (var i = 0; i < message.cdrEvents.length; ++i) {
                        var error = $root.sipjsserver.call.CdrEvent.verify(message.cdrEvents[i], long + 1);
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
                if (message.aLegPendingViasPresent != null && message.hasOwnProperty("aLegPendingViasPresent"))
                    if (typeof message.aLegPendingViasPresent !== "boolean")
                        return "aLegPendingViasPresent: boolean expected";
                if (message.aLegPendingCSeq != null && message.hasOwnProperty("aLegPendingCSeq")) {
                    properties._aLegPendingCSeq = 1;
                    if (!$util.isInteger(message.aLegPendingCSeq))
                        return "aLegPendingCSeq: integer expected";
                }
                if (message.tagMap != null && message.hasOwnProperty("tagMap")) {
                    if (!Array.isArray(message.tagMap))
                        return "tagMap: array expected";
                    for (var i = 0; i < message.tagMap.length; ++i) {
                        var error = $root.sipjsserver.call.TagMapping.verify(message.tagMap[i], long + 1);
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
                        var error = $root.sipjsserver.call.CallTopology.verify(message.topology, long + 1);
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
                if (message.policyUpdateBodyIsNull != null && message.hasOwnProperty("policyUpdateBodyIsNull")) {
                    properties._policyUpdateBodyIsNull = 1;
                    if (typeof message.policyUpdateBodyIsNull !== "boolean")
                        return "policyUpdateBodyIsNull: boolean expected";
                }
                if (message.activeRules != null && message.hasOwnProperty("activeRules")) {
                    if (!Array.isArray(message.activeRules))
                        return "activeRules: array expected";
                    for (var i = 0; i < message.activeRules.length; ++i) {
                        var error = $root.sipjsserver.call.ActiveRule.verify(message.activeRules[i], long + 1);
                        if (error)
                            return "activeRules." + error;
                    }
                }
                if (message.activeRulesPresent != null && message.hasOwnProperty("activeRulesPresent"))
                    if (typeof message.activeRulesPresent !== "boolean")
                        return "activeRulesPresent: boolean expected";
                if (message.ruleState != null && message.hasOwnProperty("ruleState")) {
                    if (!Array.isArray(message.ruleState))
                        return "ruleState: array expected";
                    for (var i = 0; i < message.ruleState.length; ++i) {
                        var error = $root.sipjsserver.call.RuleStateEntry.verify(message.ruleState[i], long + 1);
                        if (error)
                            return "ruleState." + error;
                    }
                }
                if (message.ruleStatePresent != null && message.hasOwnProperty("ruleStatePresent"))
                    if (typeof message.ruleStatePresent !== "boolean")
                        return "ruleStatePresent: boolean expected";
                if (message.messageCount != null && message.hasOwnProperty("messageCount")) {
                    properties._messageCount = 1;
                    if (!$util.isInteger(message.messageCount))
                        return "messageCount: integer expected";
                }
                if (message.terminatingRefreshLegs != null && message.hasOwnProperty("terminatingRefreshLegs")) {
                    if (!Array.isArray(message.terminatingRefreshLegs))
                        return "terminatingRefreshLegs: array expected";
                    for (var i = 0; i < message.terminatingRefreshLegs.length; ++i)
                        if (!$util.isString(message.terminatingRefreshLegs[i]))
                            return "terminatingRefreshLegs: string[] expected";
                }
                if (message.terminatingRefreshLegsPresent != null && message.hasOwnProperty("terminatingRefreshLegsPresent"))
                    if (typeof message.terminatingRefreshLegsPresent !== "boolean")
                        return "terminatingRefreshLegsPresent: boolean expected";
                if (message.extJson != null && message.hasOwnProperty("extJson")) {
                    properties._extJson = 1;
                    if (!$util.isString(message.extJson))
                        return "extJson: string expected";
                }
                return null;
            };

            /**
             * Creates a Call message from a plain object. Also converts values to their respective internal types.
             * @function fromObject
             * @memberof sipjsserver.call.Call
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {sipjsserver.call.Call} Call
             */
            Call.fromObject = function fromObject(object, long) {
                if (object instanceof $root.sipjsserver.call.Call)
                    return object;
                if (long === undefined)
                    long = 0;
                if (long > $util.recursionLimit)
                    throw Error("maximum nesting depth exceeded");
                var message = new $root.sipjsserver.call.Call();
                if (object.callRef != null)
                    message.callRef = String(object.callRef);
                if (object.aLeg != null) {
                    if (typeof object.aLeg !== "object")
                        throw TypeError(".sipjsserver.call.Call.aLeg: object expected");
                    message.aLeg = $root.sipjsserver.call.Leg.fromObject(object.aLeg, long + 1);
                }
                if (object.bLegs) {
                    if (!Array.isArray(object.bLegs))
                        throw TypeError(".sipjsserver.call.Call.bLegs: array expected");
                    message.bLegs = [];
                    for (var i = 0; i < object.bLegs.length; ++i) {
                        if (typeof object.bLegs[i] !== "object")
                            throw TypeError(".sipjsserver.call.Call.bLegs: object expected");
                        message.bLegs[i] = $root.sipjsserver.call.Leg.fromObject(object.bLegs[i], long + 1);
                    }
                }
                if (object.activePeer != null) {
                    if (typeof object.activePeer !== "object")
                        throw TypeError(".sipjsserver.call.Call.activePeer: object expected");
                    message.activePeer = $root.sipjsserver.call.ActivePeer.fromObject(object.activePeer, long + 1);
                }
                if (object.activePeerIsNull != null)
                    message.activePeerIsNull = Boolean(object.activePeerIsNull);
                if (object.callbackContext != null)
                    message.callbackContext = String(object.callbackContext);
                if (object.billingContext != null)
                    message.billingContext = String(object.billingContext);
                if (object.billingContextIsNull != null)
                    message.billingContextIsNull = Boolean(object.billingContextIsNull);
                if (object.aLegInvite != null) {
                    if (typeof object.aLegInvite !== "object")
                        throw TypeError(".sipjsserver.call.Call.aLegInvite: object expected");
                    message.aLegInvite = $root.sipjsserver.call.ALegInvite.fromObject(object.aLegInvite, long + 1);
                }
                if (object.limiterEntries) {
                    if (!Array.isArray(object.limiterEntries))
                        throw TypeError(".sipjsserver.call.Call.limiterEntries: array expected");
                    message.limiterEntries = [];
                    for (var i = 0; i < object.limiterEntries.length; ++i) {
                        if (typeof object.limiterEntries[i] !== "object")
                            throw TypeError(".sipjsserver.call.Call.limiterEntries: object expected");
                        message.limiterEntries[i] = $root.sipjsserver.call.CallLimiterState.fromObject(object.limiterEntries[i], long + 1);
                    }
                }
                if (object.timers) {
                    if (!Array.isArray(object.timers))
                        throw TypeError(".sipjsserver.call.Call.timers: array expected");
                    message.timers = [];
                    for (var i = 0; i < object.timers.length; ++i) {
                        if (typeof object.timers[i] !== "object")
                            throw TypeError(".sipjsserver.call.Call.timers: object expected");
                        message.timers[i] = $root.sipjsserver.call.TimerEntry.fromObject(object.timers[i], long + 1);
                    }
                }
                if (object.cdrEvents) {
                    if (!Array.isArray(object.cdrEvents))
                        throw TypeError(".sipjsserver.call.Call.cdrEvents: array expected");
                    message.cdrEvents = [];
                    for (var i = 0; i < object.cdrEvents.length; ++i) {
                        if (typeof object.cdrEvents[i] !== "object")
                            throw TypeError(".sipjsserver.call.Call.cdrEvents: object expected");
                        message.cdrEvents[i] = $root.sipjsserver.call.CdrEvent.fromObject(object.cdrEvents[i], long + 1);
                    }
                }
                if (object.state != null)
                    message.state = String(object.state);
                if (object.createdAt != null)
                    message.createdAt = Number(object.createdAt);
                if (object.aLegPendingVias) {
                    if (!Array.isArray(object.aLegPendingVias))
                        throw TypeError(".sipjsserver.call.Call.aLegPendingVias: array expected");
                    message.aLegPendingVias = [];
                    for (var i = 0; i < object.aLegPendingVias.length; ++i)
                        message.aLegPendingVias[i] = String(object.aLegPendingVias[i]);
                }
                if (object.aLegPendingViasPresent != null)
                    message.aLegPendingViasPresent = Boolean(object.aLegPendingViasPresent);
                if (object.aLegPendingCSeq != null)
                    message.aLegPendingCSeq = object.aLegPendingCSeq | 0;
                if (object.tagMap) {
                    if (!Array.isArray(object.tagMap))
                        throw TypeError(".sipjsserver.call.Call.tagMap: array expected");
                    message.tagMap = [];
                    for (var i = 0; i < object.tagMap.length; ++i) {
                        if (typeof object.tagMap[i] !== "object")
                            throw TypeError(".sipjsserver.call.Call.tagMap: object expected");
                        message.tagMap[i] = $root.sipjsserver.call.TagMapping.fromObject(object.tagMap[i], long + 1);
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
                        throw TypeError(".sipjsserver.call.Call.topology: object expected");
                    message.topology = $root.sipjsserver.call.CallTopology.fromObject(object.topology, long + 1);
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
                if (object.policyUpdateBodyIsNull != null)
                    message.policyUpdateBodyIsNull = Boolean(object.policyUpdateBodyIsNull);
                if (object.activeRules) {
                    if (!Array.isArray(object.activeRules))
                        throw TypeError(".sipjsserver.call.Call.activeRules: array expected");
                    message.activeRules = [];
                    for (var i = 0; i < object.activeRules.length; ++i) {
                        if (typeof object.activeRules[i] !== "object")
                            throw TypeError(".sipjsserver.call.Call.activeRules: object expected");
                        message.activeRules[i] = $root.sipjsserver.call.ActiveRule.fromObject(object.activeRules[i], long + 1);
                    }
                }
                if (object.activeRulesPresent != null)
                    message.activeRulesPresent = Boolean(object.activeRulesPresent);
                if (object.ruleState) {
                    if (!Array.isArray(object.ruleState))
                        throw TypeError(".sipjsserver.call.Call.ruleState: array expected");
                    message.ruleState = [];
                    for (var i = 0; i < object.ruleState.length; ++i) {
                        if (typeof object.ruleState[i] !== "object")
                            throw TypeError(".sipjsserver.call.Call.ruleState: object expected");
                        message.ruleState[i] = $root.sipjsserver.call.RuleStateEntry.fromObject(object.ruleState[i], long + 1);
                    }
                }
                if (object.ruleStatePresent != null)
                    message.ruleStatePresent = Boolean(object.ruleStatePresent);
                if (object.messageCount != null)
                    message.messageCount = object.messageCount | 0;
                if (object.terminatingRefreshLegs) {
                    if (!Array.isArray(object.terminatingRefreshLegs))
                        throw TypeError(".sipjsserver.call.Call.terminatingRefreshLegs: array expected");
                    message.terminatingRefreshLegs = [];
                    for (var i = 0; i < object.terminatingRefreshLegs.length; ++i)
                        message.terminatingRefreshLegs[i] = String(object.terminatingRefreshLegs[i]);
                }
                if (object.terminatingRefreshLegsPresent != null)
                    message.terminatingRefreshLegsPresent = Boolean(object.terminatingRefreshLegsPresent);
                if (object.extJson != null)
                    message.extJson = String(object.extJson);
                return message;
            };

            /**
             * Creates a plain object from a Call message. Also converts values to other types if specified.
             * @function toObject
             * @memberof sipjsserver.call.Call
             * @static
             * @param {sipjsserver.call.Call} message Call
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            Call.toObject = function toObject(message, options, q) {
                if (!options)
                    options = {};
                if (q === undefined)
                    q = 0;
                if (q > $util.recursionLimit)
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
                    object.terminatingRefreshLegs = [];
                }
                if (options.defaults) {
                    object.callRef = "";
                    object.aLeg = null;
                    object.activePeerIsNull = false;
                    object.aLegInvite = null;
                    object.state = "";
                    object.createdAt = 0;
                    object.aLegPendingViasPresent = false;
                    object.activeRulesPresent = false;
                    object.ruleStatePresent = false;
                    object.terminatingRefreshLegsPresent = false;
                }
                if (message.callRef != null && message.hasOwnProperty("callRef"))
                    object.callRef = message.callRef;
                if (message.aLeg != null && message.hasOwnProperty("aLeg"))
                    object.aLeg = $root.sipjsserver.call.Leg.toObject(message.aLeg, options, q + 1);
                if (message.bLegs && message.bLegs.length) {
                    object.bLegs = [];
                    for (var j = 0; j < message.bLegs.length; ++j)
                        object.bLegs[j] = $root.sipjsserver.call.Leg.toObject(message.bLegs[j], options, q + 1);
                }
                if (message.activePeer != null && message.hasOwnProperty("activePeer")) {
                    object.activePeer = $root.sipjsserver.call.ActivePeer.toObject(message.activePeer, options, q + 1);
                    if (options.oneofs)
                        object._activePeer = "activePeer";
                }
                if (message.activePeerIsNull != null && message.hasOwnProperty("activePeerIsNull"))
                    object.activePeerIsNull = message.activePeerIsNull;
                if (message.callbackContext != null && message.hasOwnProperty("callbackContext")) {
                    object.callbackContext = message.callbackContext;
                    if (options.oneofs)
                        object._callbackContext = "callbackContext";
                }
                if (message.billingContext != null && message.hasOwnProperty("billingContext")) {
                    object.billingContext = message.billingContext;
                    if (options.oneofs)
                        object._billingContext = "billingContext";
                }
                if (message.billingContextIsNull != null && message.hasOwnProperty("billingContextIsNull")) {
                    object.billingContextIsNull = message.billingContextIsNull;
                    if (options.oneofs)
                        object._billingContextIsNull = "billingContextIsNull";
                }
                if (message.aLegInvite != null && message.hasOwnProperty("aLegInvite"))
                    object.aLegInvite = $root.sipjsserver.call.ALegInvite.toObject(message.aLegInvite, options, q + 1);
                if (message.limiterEntries && message.limiterEntries.length) {
                    object.limiterEntries = [];
                    for (var j = 0; j < message.limiterEntries.length; ++j)
                        object.limiterEntries[j] = $root.sipjsserver.call.CallLimiterState.toObject(message.limiterEntries[j], options, q + 1);
                }
                if (message.timers && message.timers.length) {
                    object.timers = [];
                    for (var j = 0; j < message.timers.length; ++j)
                        object.timers[j] = $root.sipjsserver.call.TimerEntry.toObject(message.timers[j], options, q + 1);
                }
                if (message.cdrEvents && message.cdrEvents.length) {
                    object.cdrEvents = [];
                    for (var j = 0; j < message.cdrEvents.length; ++j)
                        object.cdrEvents[j] = $root.sipjsserver.call.CdrEvent.toObject(message.cdrEvents[j], options, q + 1);
                }
                if (message.state != null && message.hasOwnProperty("state"))
                    object.state = message.state;
                if (message.createdAt != null && message.hasOwnProperty("createdAt"))
                    object.createdAt = options.json && !isFinite(message.createdAt) ? String(message.createdAt) : message.createdAt;
                if (message.aLegPendingVias && message.aLegPendingVias.length) {
                    object.aLegPendingVias = [];
                    for (var j = 0; j < message.aLegPendingVias.length; ++j)
                        object.aLegPendingVias[j] = message.aLegPendingVias[j];
                }
                if (message.aLegPendingViasPresent != null && message.hasOwnProperty("aLegPendingViasPresent"))
                    object.aLegPendingViasPresent = message.aLegPendingViasPresent;
                if (message.aLegPendingCSeq != null && message.hasOwnProperty("aLegPendingCSeq")) {
                    object.aLegPendingCSeq = message.aLegPendingCSeq;
                    if (options.oneofs)
                        object._aLegPendingCSeq = "aLegPendingCSeq";
                }
                if (message.tagMap && message.tagMap.length) {
                    object.tagMap = [];
                    for (var j = 0; j < message.tagMap.length; ++j)
                        object.tagMap[j] = $root.sipjsserver.call.TagMapping.toObject(message.tagMap[j], options, q + 1);
                }
                if (message.traceId != null && message.hasOwnProperty("traceId")) {
                    object.traceId = message.traceId;
                    if (options.oneofs)
                        object._traceId = "traceId";
                }
                if (message.rootSpanId != null && message.hasOwnProperty("rootSpanId")) {
                    object.rootSpanId = message.rootSpanId;
                    if (options.oneofs)
                        object._rootSpanId = "rootSpanId";
                }
                if (message.sampled != null && message.hasOwnProperty("sampled")) {
                    object.sampled = message.sampled;
                    if (options.oneofs)
                        object._sampled = "sampled";
                }
                if (message.workerIndex != null && message.hasOwnProperty("workerIndex")) {
                    object.workerIndex = message.workerIndex;
                    if (options.oneofs)
                        object._workerIndex = "workerIndex";
                }
                if (message.topology != null && message.hasOwnProperty("topology")) {
                    object.topology = $root.sipjsserver.call.CallTopology.toObject(message.topology, options, q + 1);
                    if (options.oneofs)
                        object._topology = "topology";
                }
                if (message.emergency != null && message.hasOwnProperty("emergency")) {
                    object.emergency = message.emergency;
                    if (options.oneofs)
                        object._emergency = "emergency";
                }
                if (message.featuresJson != null && message.hasOwnProperty("featuresJson")) {
                    object.featuresJson = message.featuresJson;
                    if (options.oneofs)
                        object._featuresJson = "featuresJson";
                }
                if (message.policyUpdateHeadersJson != null && message.hasOwnProperty("policyUpdateHeadersJson")) {
                    object.policyUpdateHeadersJson = message.policyUpdateHeadersJson;
                    if (options.oneofs)
                        object._policyUpdateHeadersJson = "policyUpdateHeadersJson";
                }
                if (message.policyUpdateBody != null && message.hasOwnProperty("policyUpdateBody")) {
                    object.policyUpdateBody = options.bytes === String ? $util.base64.encode(message.policyUpdateBody, 0, message.policyUpdateBody.length) : options.bytes === Array ? Array.prototype.slice.call(message.policyUpdateBody) : message.policyUpdateBody;
                    if (options.oneofs)
                        object._policyUpdateBody = "policyUpdateBody";
                }
                if (message.policyUpdateBodyIsNull != null && message.hasOwnProperty("policyUpdateBodyIsNull")) {
                    object.policyUpdateBodyIsNull = message.policyUpdateBodyIsNull;
                    if (options.oneofs)
                        object._policyUpdateBodyIsNull = "policyUpdateBodyIsNull";
                }
                if (message.activeRules && message.activeRules.length) {
                    object.activeRules = [];
                    for (var j = 0; j < message.activeRules.length; ++j)
                        object.activeRules[j] = $root.sipjsserver.call.ActiveRule.toObject(message.activeRules[j], options, q + 1);
                }
                if (message.activeRulesPresent != null && message.hasOwnProperty("activeRulesPresent"))
                    object.activeRulesPresent = message.activeRulesPresent;
                if (message.ruleState && message.ruleState.length) {
                    object.ruleState = [];
                    for (var j = 0; j < message.ruleState.length; ++j)
                        object.ruleState[j] = $root.sipjsserver.call.RuleStateEntry.toObject(message.ruleState[j], options, q + 1);
                }
                if (message.ruleStatePresent != null && message.hasOwnProperty("ruleStatePresent"))
                    object.ruleStatePresent = message.ruleStatePresent;
                if (message.messageCount != null && message.hasOwnProperty("messageCount")) {
                    object.messageCount = message.messageCount;
                    if (options.oneofs)
                        object._messageCount = "messageCount";
                }
                if (message.terminatingRefreshLegs && message.terminatingRefreshLegs.length) {
                    object.terminatingRefreshLegs = [];
                    for (var j = 0; j < message.terminatingRefreshLegs.length; ++j)
                        object.terminatingRefreshLegs[j] = message.terminatingRefreshLegs[j];
                }
                if (message.terminatingRefreshLegsPresent != null && message.hasOwnProperty("terminatingRefreshLegsPresent"))
                    object.terminatingRefreshLegsPresent = message.terminatingRefreshLegsPresent;
                if (message.extJson != null && message.hasOwnProperty("extJson")) {
                    object.extJson = message.extJson;
                    if (options.oneofs)
                        object._extJson = "extJson";
                }
                return object;
            };

            /**
             * Converts this Call to JSON.
             * @function toJSON
             * @memberof sipjsserver.call.Call
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            Call.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for Call
             * @function getTypeUrl
             * @memberof sipjsserver.call.Call
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            Call.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/sipjsserver.call.Call";
            };

            return Call;
        })();

        return call;
    })();

    return sipjsserver;
})();

module.exports = $root;
