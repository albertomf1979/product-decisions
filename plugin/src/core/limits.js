'use strict';

/** Above this size a payload is stored as hash and size, without being parsed or redacted. */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

module.exports = { MAX_PAYLOAD_BYTES };
