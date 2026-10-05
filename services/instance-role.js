/**
 * @file Which of the two server instances serves, and how one hands over to
 * the other so that a release leaves no moment in which a connecting page
 * finds no server or an empty list of proxies.
 *
 * The server runs in two slots. The proxy registry and the browsers'
 * signalling sockets live in the memory of one process, so only one instance
 * serves at a time. A release starts the new version in the slot that is not
 * serving. The new instance first takes over the proxies' tunnels, and only
 * then the pages:
 *
 * 1. The new instance (N) opens `/internal/hand-over` on its peer (O) and both
 *    say who they are. N takes over when O serves and N is not older.
 * 2. O stops accepting new tunnels and asks every proxy that follows moves to
 *    open a second connection; nginx sends that connection to N, because O
 *    refuses it. N tells O each proxy that has arrived.
 * 3. When every such proxy still connected to O has arrived at N, O tells N to
 *    serve. N serves; O stops accepting pages and new signalling sockets.
 * 4. O keeps its existing signalling sockets until the newest of them is older
 *    than the page's connect deadline — a socket that old has finished its
 *    connection attempt — then closes them and its tunnels and stands by.
 *
 * At least one instance accepts pages at every moment of steps 1-3, and nginx
 * retries a refused request on the other slot.
 *
 * States: STARTING → SERVING | STANDBY | TAKING_OVER; TAKING_OVER → SERVING;
 * SERVING → HANDING_OVER → DRAINING → STANDBY; HANDING_OVER → SERVING when the
 * new instance goes away before it serves.
 */

import { WebSocket } from "ws";

export const InstanceState = Object.freeze({
  STARTING: "starting",
  STANDBY: "standby",
  TAKING_OVER: "taking-over",
  SERVING: "serving",
  HANDING_OVER: "handing-over",
  DRAINING: "draining"
});

/**
 * Compare two dotted version strings numerically.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative when `a` is older, positive when newer, 0 when equal.
 */
export function compareVersions(a, b) {
  const left = String(a).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * What a starting instance does, given what its peer says about itself.
 *
 * A serving peer is taken over by an instance that is not older than it; an
 * older one stands by, so a restart of the previous version never replaces the
 * current one. Of two instances starting together the newer one serves, and
 * between equal versions the slot that sorts first.
 *
 * @param {{ version: string, slot: string }} self
 * @param {{ state: string, version: string, slot: string } | null} peer - null when it did not answer.
 * @returns {"serve" | "take-over" | "standby"}
 */
export function decideOnPeer(self, peer) {
  if (!peer) {
    return "serve";
  }
  const order = compareVersions(self.version, peer.version);
  if (peer.state === InstanceState.SERVING) {
    return order >= 0 ? "take-over" : "standby";
  }
  if (peer.state === InstanceState.STANDBY) {
    return "serve";
  }
  if (peer.state === InstanceState.STARTING) {
    if (order !== 0) {
      return order > 0 ? "serve" : "standby";
    }
    return self.slot < peer.slot ? "serve" : "standby";
  }
  // The peer is in the middle of a handover, which with two slots can only be
  // with an earlier life of this one. It ends serving or standing by, and this
  // instance stands by meanwhile.
  return "standby";
}

/**
 * @typedef {Object} InstanceRole
 * @property {() => Promise<void>} start - Find out what the peer is doing and act on it. Call after listening.
 * @property {(socket: import("ws").WebSocket) => void} acceptPeer - Serve `/internal/hand-over`.
 * @property {(proxyId: string, connected: boolean) => void} onProxyConnection - A tunnel opened or closed.
 * @property {() => boolean} acceptsPages - Pages and new signalling sockets are served here now.
 * @property {() => boolean} acceptsTunnels - New proxy tunnels are accepted here now.
 * @property {() => { state: string, slot: string }} describe
 */

/**
 * @param {{
 *   slot: string,
 *   version: string,
 *   peerUrl: string | null,
 *   tunnelServer: import("./proxy-tunnel-server.js").ProxyTunnelServer,
 *   signalHub: import("./signal-hub.js").SignalHub,
 *   connectDeadlineMs: number,
 *   onServe?: () => Promise<void> | void,
 *   onLeave?: () => Promise<void> | void,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   connectPeer?: (url: string) => import("ws").WebSocket
 * }} options
 * @returns {InstanceRole}
 */
export function createInstanceRole({
  slot,
  version,
  peerUrl,
  tunnelServer,
  signalHub,
  connectDeadlineMs,
  onServe = () => {},
  onLeave = () => {},
  log = (line) => console.log(line),
  now = Date.now,
  connectPeer = (url) => new WebSocket(url)
}) {
  let state = InstanceState.STARTING;
  /**
   * The starting instance's link to the one it takes over from.
   *
   * @type {import("ws").WebSocket | null}
   */
  let takingOverFrom = null;
  /**
   * The serving instance's link to the one taking over from it.
   *
   * @type {import("ws").WebSocket | null}
   */
  let handingOverTo = null;
  /**
   * Proxies that follow moves and have not yet arrived at the new instance.
   *
   * @type {Set<string> | null}
   */
  let waitingFor = null;
  let serveSent = false;
  let left = false;

  const say = (line) => log(`[instance ${slot}] ${line}`);
  const send = (socket, message) => {
    if (socket?.readyState === 1 /* OPEN */) {
      socket.send(JSON.stringify(message));
    }
  };

  async function becomeServing(reason) {
    await onServe();
    left = false;
    state = InstanceState.SERVING;
    say(`serving v${version}: ${reason}`);
  }

  async function leave() {
    if (!left) {
      left = true;
      await onLeave();
    }
  }

  async function checkHandedOver() {
    if (state !== InstanceState.HANDING_OVER || serveSent || waitingFor === null || waitingFor.size > 0) {
      return;
    }
    serveSent = true;
    await leave();
    // The new instance may have gone while this one was letting go.
    if (state !== InstanceState.HANDING_OVER) {
      return;
    }
    say("every proxy that follows moves has arrived at the new instance; telling it to serve");
    send(handingOverTo, { type: "serve" });
  }

  function startDraining() {
    state = InstanceState.DRAINING;
    waitingFor = null;
    const latest = signalHub.latestOpenedAt();
    const waitMs = latest === null ? 0 : Math.max(0, latest + connectDeadlineMs - now());
    say(`the new instance serves; finishing the signalling under way here (${waitMs} ms: the page's connect deadline from its newest socket)`);
    setTimeout(() => {
      signalHub.closeAll(1012, "server restart");
      tunnelServer.closeAll(1012, "server restart");
      state = InstanceState.STANDBY;
      say("standing by");
    }, waitMs);
  }

  async function onStarterMessage(socket, message) {
    if (message.type === "state" && state === InstanceState.STARTING) {
      const decision = decideOnPeer({ version, slot }, message);
      say(`the peer (slot ${message.slot}, v${message.version}) is ${message.state}: ${decision}`);
      if (decision === "serve") {
        socket.close(1000, "done");
        await becomeServing(`the peer is ${message.state}`);
      } else if (decision === "standby") {
        socket.close(1000, "done");
        state = InstanceState.STANDBY;
        await leave();
      } else {
        state = InstanceState.TAKING_OVER;
        takingOverFrom = socket;
        send(socket, { type: "take-over", slot });
        for (const { proxyId } of tunnelServer.connectedProxies()) {
          send(socket, { type: "arrived", proxyId });
        }
      }
      return;
    }
    if (message.type === "serve" && state === InstanceState.TAKING_OVER) {
      takingOverFrom = null;
      await becomeServing("the peer has handed over");
      send(socket, { type: "serving" });
      socket.close(1000, "done");
      return;
    }
    if (message.type === "refused" && state === InstanceState.TAKING_OVER) {
      takingOverFrom = null;
      socket.close(1000, "done");
      await becomeServing(`the peer refused the handover (it is ${message.state})`);
    }
  }

  return {
    async start() {
      if (!peerUrl) {
        await becomeServing("no peer is configured");
        return;
      }
      let answered = false;
      const socket = connectPeer(peerUrl);
      socket.on("open", () => {
        send(socket, { type: "hello", slot, version });
      });
      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message.type === "state") {
          answered = true;
        }
        void onStarterMessage(socket, message);
      });
      const ended = (reason) => {
        if (!answered) {
          answered = true;
          void becomeServing(`the peer did not answer (${reason})`);
        } else if (state === InstanceState.TAKING_OVER && takingOverFrom === socket) {
          takingOverFrom = null;
          void becomeServing("the peer went away during the handover");
        }
      };
      socket.on("error", (error) => ended(error?.message ?? "error"));
      socket.on("close", () => ended("closed"));
    },

    acceptPeer(socket) {
      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message.type === "hello") {
          send(socket, { type: "state", state, slot, version });
          return;
        }
        if (message.type === "take-over") {
          if (state !== InstanceState.SERVING) {
            send(socket, { type: "refused", state });
            return;
          }
          state = InstanceState.HANDING_OVER;
          handingOverTo = socket;
          serveSent = false;
          const followers = tunnelServer.connectedProxies().filter((proxy) => proxy.followsMoves);
          waitingFor = new Set(followers.map((proxy) => proxy.proxyId));
          say(`handing over to slot ${message.slot ?? "?"}; asking ${followers.length} proxy(ies) to move`);
          for (const { proxyId } of followers) {
            tunnelServer.askToMove(proxyId);
          }
          void checkHandedOver();
          return;
        }
        if (message.type === "arrived" && socket === handingOverTo && waitingFor) {
          waitingFor.delete(String(message.proxyId));
          void checkHandedOver();
          return;
        }
        if (message.type === "serving" && socket === handingOverTo && state === InstanceState.HANDING_OVER) {
          handingOverTo = null;
          startDraining();
        }
      });
      socket.on("close", () => {
        if (socket === handingOverTo && state === InstanceState.HANDING_OVER) {
          handingOverTo = null;
          waitingFor = null;
          serveSent = false;
          void becomeServing("the new instance went away before it served");
        }
      });
    },

    onProxyConnection(proxyId, connected) {
      if (connected && state === InstanceState.TAKING_OVER) {
        send(takingOverFrom, { type: "arrived", proxyId });
      }
      if (!connected && state === InstanceState.HANDING_OVER && waitingFor) {
        waitingFor.delete(proxyId);
        void checkHandedOver();
      }
    },

    acceptsPages() {
      return state === InstanceState.SERVING || state === InstanceState.HANDING_OVER;
    },

    acceptsTunnels() {
      return state === InstanceState.SERVING || state === InstanceState.TAKING_OVER;
    },

    describe() {
      return { state, slot };
    }
  };
}
