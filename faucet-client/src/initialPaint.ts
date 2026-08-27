const INITIAL_RESOURCE_TIMEOUT_MS = 10000;

function scheduleTimeout(windowRef: Window | null, callback: () => void): number | ReturnType<typeof setTimeout> {
  return windowRef ? windowRef.setTimeout(callback, INITIAL_RESOURCE_TIMEOUT_MS) : setTimeout(callback, INITIAL_RESOURCE_TIMEOUT_MS);
}

function waitForPromise(promise: PromiseLike<unknown>, windowRef: Window | null): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: number | ReturnType<typeof setTimeout>;
    const finish = () => {
      if(settled)
        return;
      settled = true;
      if(timer !== undefined)
        clearTimeout(timer);
      resolve();
    };
    timer = scheduleTimeout(windowRef, finish);
    Promise.resolve(promise).then(finish, finish);
  });
}

function waitForEvent(
  target: EventTarget,
  eventNames: string[],
  isReady: () => boolean,
  windowRef: Window | null,
): Promise<void> {
  if(isReady())
    return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    let timer: number | ReturnType<typeof setTimeout>;
    const finish = () => {
      if(settled)
        return;
      settled = true;
      eventNames.forEach((eventName) => target.removeEventListener(eventName, finish));
      if(timer !== undefined)
        clearTimeout(timer);
      resolve();
    };
    eventNames.forEach((eventName) => target.addEventListener(eventName, finish, { once: true }));
    timer = scheduleTimeout(windowRef, finish);
  });
}

function waitForStylesheet(link: HTMLLinkElement, windowRef: Window | null): Promise<void> {
  return waitForEvent(
    link,
    ["load", "error"],
    () => {
      try {
        return !!link.sheet;
      } catch {
        return false;
      }
    },
    windowRef,
  );
}

function waitForImage(image: HTMLImageElement, windowRef: Window | null): Promise<void> {
  if(!image.getAttribute("src"))
    return Promise.resolve();

  const decode = () => {
    if(typeof image.decode !== "function")
      return Promise.resolve();
    try {
      return waitForPromise(image.decode(), windowRef);
    } catch {
      return Promise.resolve();
    }
  };

  if(image.complete)
    return decode();

  return waitForEvent(image, ["load", "error"], () => image.complete, windowRef)
    .then(() => image.complete ? decode() : undefined);
}

async function waitForInitialResources(documentRef: Document, windowRef: Window | null): Promise<void> {
  const stylesheets = Array.from(documentRef.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'));
  const images = Array.from(documentRef.images);
  const fontReady = documentRef.fonts?.ready
    ? waitForPromise(documentRef.fonts.ready, windowRef)
    : Promise.resolve();

  await Promise.all([
    ...stylesheets.map((link) => waitForStylesheet(link, windowRef)),
    ...images.map((image) => waitForImage(image, windowRef)),
    fontReady,
  ]);
}

function nextFrame(windowRef: Window | null): Promise<void> {
  if(windowRef?.requestAnimationFrame) {
    return new Promise((resolve) => windowRef.requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait for the first React tree's styles, fonts, and images to settle, then
 * allow the document to paint it. A second pass covers assets mounted by
 * child effects during the first committed frame.
 */
export async function waitForInitialPaint(documentRef: Document = document): Promise<void> {
  const windowRef = documentRef.defaultView;
  await waitForInitialResources(documentRef, windowRef);
  await nextFrame(windowRef);
  await waitForInitialResources(documentRef, windowRef);
  await nextFrame(windowRef);
}

/**
 * Publish one stable readiness marker for the pre-paint HTML gate. Resource
 * failures are treated as settled after their bounded wait so a failed
 * optional asset cannot leave the whole application permanently blank.
 */
export async function revealInitialPaint(documentRef: Document = document): Promise<void> {
  try {
    await waitForInitialPaint(documentRef);
  } catch {
    // A broken optional resource must not leave the pre-paint gate closed or
    // produce an unhandled rejection from the fire-and-forget caller.
  } finally {
    documentRef.documentElement.setAttribute("data-faucet-ready", "1");
    documentRef.documentElement.classList.remove("faucet-booting");
  }
}
