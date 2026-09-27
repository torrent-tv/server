/**
 * @file The picture as the viewer sees it, in physical pixels (roadmap item 98).
 *
 * WHAT IS MEASURED. The frame the proxy would have to produce so that the part
 * of it on screen is shown without being enlarged. It is not the size of the
 * window: a landscape film on a phone held upright fills the width and a strip
 * of the height, and the window's long and short edges — what was sent before —
 * asked for a picture about three times taller than the one shown. Nor is it
 * the size of the element: `object-fit` decides how the frame sits in the
 * element, and `object-position` which part of it is inside.
 *
 * HOW, in four steps:
 *
 * 1. the frame's rendered rectangle inside the element, from the element's
 *    content box, the video's own proportions, and the computed `object-fit`
 *    and `object-position`;
 * 2. the part of that rectangle inside the element — only that part is seen;
 * 3. the physical pixels that part covers, from `devicePixelContentBoxSize`
 *    where the browser reports it, otherwise from `devicePixelRatio`;
 * 4. the frame whose visible part has at least those pixels: the visible
 *    physical size divided by the fraction of the frame that is visible.
 *
 * Step 4 comes out as the rendered rectangle in physical pixels whenever any of
 * the frame is visible — the fraction cancels. `object-position` still matters:
 * it decides whether any of the frame is inside the element at all.
 *
 * The proxy chooses the smallest rung of its ladder whose frame is not smaller
 * than this, and uses it as the upper bound of a re-encoded output's height.
 * The page does not choose the rung: which rungs exist is the proxy's answer.
 */

/**
 * A size, or null when it is not a positive width and height.
 *
 * @param {unknown} value
 * @returns {{ width: number, height: number } | null}
 */
export function pictureSizeOf(value) {
  const width = Math.round(Number(/** @type {{ width?: unknown }} */ (value)?.width));
  const height = Math.round(Number(/** @type {{ height?: unknown }} */ (value)?.height));
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Where the frame's rectangle starts along one axis, from one component of
 * `object-position` as `getComputedStyle` reports it: a percentage of the free
 * space, a length in CSS pixels, or a keyword.
 *
 * @param {string} component
 * @param {number} free - The element's size less the rectangle's, on this axis.
 * @returns {number}
 */
function offsetAlong(component, free) {
  const text = String(component ?? "").trim();
  if (text === "left" || text === "top") {
    return 0;
  }
  if (text === "right" || text === "bottom") {
    return free;
  }
  if (text === "" || text === "center") {
    return free / 2;
  }
  if (text.endsWith("%")) {
    const percent = Number.parseFloat(text);
    return Number.isFinite(percent) ? (free * percent) / 100 : free / 2;
  }
  const length = Number.parseFloat(text);
  return Number.isFinite(length) ? length : free / 2;
}

/**
 * The two components of `object-position`, horizontal first.
 *
 * A single keyword names one axis and centres the other; `top`/`bottom` alone
 * name the vertical one. The computed value is normally two components already.
 *
 * @param {string} position
 * @returns {[string, string]}
 */
function positionComponents(position) {
  const parts = String(position ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return ["50%", "50%"];
  }
  if (parts.length === 1) {
    return parts[0] === "top" || parts[0] === "bottom" ? ["50%", parts[0]] : [parts[0], "50%"];
  }
  return [parts[0], parts[1]];
}

/**
 * The frame's rendered size inside the element, in CSS pixels.
 *
 * @param {string} objectFit
 * @param {{ width: number, height: number }} box
 * @param {{ width: number, height: number }} video
 * @returns {{ width: number, height: number }}
 */
function renderedSize(objectFit, box, video) {
  if (objectFit === "fill") {
    return { width: box.width, height: box.height };
  }
  const contain = Math.min(box.width / video.width, box.height / video.height);
  const scale = objectFit === "cover"
    ? Math.max(box.width / video.width, box.height / video.height)
    : objectFit === "none"
      ? 1
      : objectFit === "scale-down"
        ? Math.min(1, contain)
        : contain;
  return { width: video.width * scale, height: video.height * scale };
}

/**
 * The frame whose visible part is shown without being enlarged, in physical
 * pixels, or null when nothing of the frame can be seen or the inputs are not
 * known yet.
 *
 * @param {object} params
 * @param {{ width: number, height: number }} params.box - The element's content
 *   box, in CSS pixels.
 * @param {{ width: number, height: number } | null} params.devicePixels - The
 *   same box in physical pixels, when the browser reports it
 *   (`devicePixelContentBoxSize`).
 * @param {number} params.devicePixelRatio - Used when `devicePixels` is absent.
 * @param {{ width: number, height: number }} params.video - The video's own
 *   size, which gives its proportions.
 * @param {string} params.objectFit - The computed `object-fit`.
 * @param {string} params.objectPosition - The computed `object-position`.
 * @returns {{ width: number, height: number } | null}
 */
export function visiblePictureOf({ box, devicePixels, devicePixelRatio, video, objectFit, objectPosition }) {
  const boxSize = pictureSizeOf(box) ? box : null;
  const videoSize = pictureSizeOf(video) ? video : null;
  if (!boxSize || !videoSize || !(box.width > 0) || !(box.height > 0)) {
    return null;
  }
  const measured = devicePixels && devicePixels.width > 0 && devicePixels.height > 0 ? devicePixels : null;
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const scaleX = measured ? measured.width / box.width : ratio;
  const scaleY = measured ? measured.height / box.height : ratio;
  const rendered = renderedSize(String(objectFit ?? "contain"), box, video);
  const [horizontal, vertical] = positionComponents(objectPosition);
  const left = offsetAlong(horizontal, box.width - rendered.width);
  const top = offsetAlong(vertical, box.height - rendered.height);
  // The part of the rectangle inside the element.
  const visibleWidth = Math.min(box.width, left + rendered.width) - Math.max(0, left);
  const visibleHeight = Math.min(box.height, top + rendered.height) - Math.max(0, top);
  if (!(visibleWidth > 0) || !(visibleHeight > 0)) {
    return null;
  }
  // The fraction of the frame that is visible, per axis, and the frame whose
  // visible part has as many pixels as the screen shows there.
  const fractionX = visibleWidth / rendered.width;
  const fractionY = visibleHeight / rendered.height;
  return pictureSizeOf({
    width: (visibleWidth * scaleX) / fractionX,
    height: (visibleHeight * scaleY) / fractionY
  });
}

/**
 * Follows the visible picture of one `<video>` element and says when it
 * changes.
 *
 * Driven by events only: `ResizeObserver` on the element (in physical pixels
 * where the browser can report them), a `matchMedia` query on the current
 * pixel density — resubscribed to the new density each time it changes,
 * because such a query answers only for the one value it names — and the
 * element's own `loadedmetadata` and `resize`, which change the proportions.
 * `object-fit` and `object-position` are read at every measurement.
 */
export class VisiblePictureWatch {
  /** @type {HTMLVideoElement} */
  #video;
  /** @type {(size: { width: number, height: number }) => void} */
  #onChange;
  /** @type {() => { width: number, height: number } | null} */
  #fallbackVideoSize;
  /** @type {ResizeObserver | null} */
  #observer = null;
  /** @type {MediaQueryList | null} */
  #densityQuery = null;
  /** @type {{ width: number, height: number } | null} */
  #box = null;
  /** @type {{ width: number, height: number } | null} */
  #devicePixels = null;
  /** @type {{ width: number, height: number } | null} */
  #current = null;

  /**
   * @param {HTMLVideoElement} video
   * @param {object} options
   * @param {(size: { width: number, height: number }) => void} options.onChange
   * @param {() => { width: number, height: number } | null} [options.fallbackVideoSize] -
   *   The video's size before the element knows it (before its metadata).
   */
  constructor(video, { onChange, fallbackVideoSize = () => null }) {
    this.#video = video;
    this.#onChange = onChange;
    this.#fallbackVideoSize = fallbackVideoSize;
  }

  /** @returns {{ width: number, height: number } | null} */
  current() {
    return this.#current;
  }

  /** @returns {void} */
  start() {
    if (this.#observer || typeof ResizeObserver !== "function") {
      return;
    }
    this.#observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const content = entry?.contentBoxSize?.[0];
      const device = entry?.devicePixelContentBoxSize?.[0];
      this.#box = content ? { width: content.inlineSize, height: content.blockSize } : null;
      this.#devicePixels = device ? { width: device.inlineSize, height: device.blockSize } : null;
      this.measure();
    });
    try {
      this.#observer.observe(this.#video, { box: "device-pixel-content-box" });
    } catch {
      // silent-ok: a browser that cannot report the box in physical pixels
      // reports it in CSS pixels, and `devicePixelRatio` converts it.
      this.#observer.observe(this.#video);
    }
    this.#video.addEventListener("loadedmetadata", this.measure);
    this.#video.addEventListener("resize", this.measure);
    this.#followDensity();
  }

  /** @returns {void} */
  stop() {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#densityQuery?.removeEventListener("change", this.#onDensityChange);
    this.#densityQuery = null;
    this.#video.removeEventListener("loadedmetadata", this.measure);
    this.#video.removeEventListener("resize", this.measure);
  }

  /**
   * Measure now and say so if the answer changed.
   *
   * @returns {void}
   */
  measure = () => {
    const box = this.#box ?? { width: this.#video.clientWidth, height: this.#video.clientHeight };
    const own = { width: this.#video.videoWidth, height: this.#video.videoHeight };
    const video = pictureSizeOf(own) ?? this.#fallbackVideoSize();
    let style = null;
    try {
      style = getComputedStyle(this.#video);
    } catch {
      // silent-ok: without a computed style the element is laid out with the
      // initial values, which are these.
    }
    const size = visiblePictureOf({
      box,
      devicePixels: this.#devicePixels,
      devicePixelRatio: window.devicePixelRatio,
      video: video ?? { width: 0, height: 0 },
      objectFit: style?.objectFit || "contain",
      objectPosition: style?.objectPosition || "50% 50%"
    });
    if (!size) {
      return;
    }
    if (this.#current && this.#current.width === size.width && this.#current.height === size.height) {
      return;
    }
    this.#current = size;
    this.#onChange(size);
  };

  /** @returns {void} */
  #followDensity() {
    this.#densityQuery?.removeEventListener("change", this.#onDensityChange);
    this.#densityQuery = null;
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const ratio = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    this.#densityQuery = window.matchMedia(`(resolution: ${ratio}dppx)`);
    this.#densityQuery.addEventListener("change", this.#onDensityChange);
  }

  #onDensityChange = () => {
    // The box in physical pixels changes with the density; the observer reports
    // it where it can, and where it cannot the ratio read at measurement does.
    this.#devicePixels = null;
    this.#followDensity();
    this.measure();
  };
}
