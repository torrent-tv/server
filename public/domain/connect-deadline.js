/**
 * The longest a page waits for one WebRTC connection to a proxy to open,
 * signalling included.
 *
 * Shared with the server: an instance that hands over keeps its signalling
 * sockets until the newest of them is this old, because a socket that old has
 * finished its connection attempt one way or the other
 * (`services/instance-role.js`). A caller may pass a shorter deadline, never a
 * longer one.
 */
export const CONNECT_TIMEOUT_MS = 30_000;
