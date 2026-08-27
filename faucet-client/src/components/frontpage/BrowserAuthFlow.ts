export type AuthModule = "github" | "zupass";

export type AuthResult<T> =
  | { data: T }
  | { errorCode: string; errorMessage?: string };

type AuthEnvelope<T> = {
  authModule: AuthModule;
  authState: string;
  authResult: AuthResult<T>;
};

type DataValidator<T> = (value: unknown) => value is T;
type ResultHandler<T> = (result: AuthResult<T>) => void;
type PopupStateHandler = (isOpen: boolean) => void;

const AUTH_STATE_BYTES = 32;
const AUTH_STATE_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isAuthResult<T>(value: unknown, isData: DataValidator<T>): value is AuthResult<T> {
  if(!isRecord(value))
    return false;

  if("data" in value) {
    return Object.keys(value).length === 1 && isData(value.data);
  }

  return hasOnlyKeys(value, ["errorCode", "errorMessage"])
    && typeof value.errorCode === "string"
    && value.errorCode.length > 0
    && (value.errorMessage === undefined || typeof value.errorMessage === "string");
}

function createAuthState(): string {
  const stateBytes = new Uint8Array(AUTH_STATE_BYTES);
  crypto.getRandomValues(stateBytes);
  return Array.from(stateBytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function submitPostForm(action: string, target: string): void {
  const form = document.createElement("form");
  form.action = action;
  form.hidden = true;
  form.method = "POST";
  form.target = target;
  document.body.appendChild(form);
  try {
    form.submit();
  } finally {
    document.body.removeChild(form);
  }
}

export function addAuthCallbackParams(
  url: string,
  params: { clientOrigin: string; state?: string },
): string {
  const callbackUrl = new URL(url, window.location.href);
  callbackUrl.searchParams.set("clientOrigin", params.clientOrigin);
  if(params.state !== undefined)
    callbackUrl.searchParams.set("state", params.state);
  return callbackUrl.toString();
}

export function postBrowserAuthRequest(url: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    cache: "no-store",
    credentials: "include",
  });
}

export class BrowserAuthFlow<T> {
  private readonly stateStorageKey: string;
  private readonly messageListener = (event: MessageEvent<unknown>) => this.processMessage(event);
  private readonly storageListener = (event: StorageEvent) => this.processStorage(event);
  private expectedOrigin: string | null = null;
  private isAttached = false;
  private popup: Window | null = null;
  private popupPollTimer: number | null = null;

  public constructor(
    private readonly authModule: AuthModule,
    private readonly isData: DataValidator<T>,
    private readonly onResult: ResultHandler<T>,
    private readonly onPopupState: PopupStateHandler,
  ) {
    this.stateStorageKey = `${authModule}.AuthState`;
  }

  public attach(): boolean {
    if(!this.isAttached) {
      window.addEventListener("message", this.messageListener);
      window.addEventListener("storage", this.storageListener);
      this.isAttached = true;
    }

    const storedResult = this.consumeStoredResult();
    if(!storedResult)
      return false;

    this.onResult(storedResult);
    return true;
  }

  public detach(): void {
    if(this.isAttached) {
      window.removeEventListener("message", this.messageListener);
      window.removeEventListener("storage", this.storageListener);
      this.isAttached = false;
    }
    this.clearPollTimer();
    this.cancel();
    this.popup = null;
    this.expectedOrigin = null;
  }

  public start(buildUrl: (state: string) => string, callbackUrl: string, features: string): void {
    this.startWithNavigation(
      callbackUrl,
      (state) => window.open(buildUrl(state), "_blank", features),
    );
  }

  public startWithPost(buildUrl: (state: string) => string, callbackUrl: string, features: string): void {
    this.startWithNavigation(callbackUrl, (state) => {
      const action = buildUrl(state);
      const target = `${this.authModule}-auth-${createAuthState()}`;
      const popup = window.open("", target, features);
      if(!popup)
        return null;

      try {
        submitPostForm(action, target);
      } catch(error) {
        try {
          popup.close();
        } catch {}
        throw error;
      }
      return popup;
    });
  }

  private startWithNavigation(callbackUrl: string, navigate: (state: string) => Window | null): void {
    if(this.popup && !this.popup.closed) {
      this.popup.focus();
      return;
    }
    if(this.popup) {
      this.clearPollTimer();
      this.popup = null;
    }
    this.cancel();

    try {
      const callbackOrigin = new URL(callbackUrl, window.location.href).origin;
      if(callbackOrigin === "null")
        throw new Error("callback URL has no network origin");
      this.expectedOrigin = callbackOrigin;
    } catch(error) {
      this.expectedOrigin = null;
      this.onPopupState(false);
      console.error(`Could not resolve ${this.authModule} callback origin.`, error);
      return;
    }

    const state = this.begin();
    if(!state) {
      this.expectedOrigin = null;
      return;
    }

    try {
      this.popup = navigate(state);
    } catch(error) {
      this.popup = null;
      console.error(`Could not open ${this.authModule} authentication.`, error);
    }

    if(!this.popup) {
      this.cancel();
      this.expectedOrigin = null;
      this.onPopupState(false);
      return;
    }

    this.onPopupState(true);
    this.pollPopupState();
  }

  public startWithIssuedState(
    issueState: () => Promise<string>,
    buildUrl: (state: string) => string,
    callbackUrl: string,
    features: string,
    onStateReady?: (state: string) => void,
  ): void {
    if(this.popup && !this.popup.closed) {
      this.popup.focus();
      return;
    }
    if(this.popup) {
      this.clearPollTimer();
      this.popup = null;
    }
    this.cancel();

    try {
      const callbackOrigin = new URL(callbackUrl, window.location.href).origin;
      if(callbackOrigin === "null")
        throw new Error("callback URL has no network origin");
      this.expectedOrigin = callbackOrigin;
    } catch(error) {
      this.expectedOrigin = null;
      this.onPopupState(false);
      console.error(`Could not resolve ${this.authModule} callback origin.`, error);
      return;
    }

    let popup: Window | null = null;
    try {
      popup = window.open("", "_blank", features);
    } catch(error) {
      console.error(`Could not open ${this.authModule} authentication.`, error);
    }
    if(!popup) {
      this.expectedOrigin = null;
      this.onPopupState(false);
      return;
    }

    this.popup = popup;
    this.onPopupState(true);
    this.pollPopupState();

    issueState().then((issuedState) => {
      if(this.popup !== popup || popup.closed)
        return;

      const state = this.begin(issuedState);
      if(!state)
        throw new Error("server returned an invalid authentication state");
      const url = buildUrl(state);
      popup.location.replace(url);
      onStateReady?.(state);
    }).catch((error) => {
      if(this.popup !== popup)
        return;
      this.clearPollTimer();
      try {
        popup.close();
      } catch {}
      this.popup = null;
      this.expectedOrigin = null;
      this.cancel();
      this.onPopupState(false);
      console.error(`Could not initialize ${this.authModule} authentication.`, error);
    });
  }

  private begin(issuedState?: string): string | null {
    try {
      const state = issuedState === undefined ? createAuthState() : issuedState;
      if(!AUTH_STATE_PATTERN.test(state))
        return null;
      sessionStorage.setItem(this.stateStorageKey, state);
      return state;
    } catch(error) {
      console.error(`Could not initialize ${this.authModule} authentication state.`, error);
      return null;
    }
  }

  private cancel(): void {
    try {
      const state = sessionStorage.getItem(this.stateStorageKey);
      sessionStorage.removeItem(this.stateStorageKey);
      if(state && AUTH_STATE_PATTERN.test(state))
        localStorage.removeItem(this.getResultStorageKey(state));
    } catch(error) {
      console.error(`Could not clear ${this.authModule} authentication state.`, error);
    }
  }

  private consumeStoredResult(): AuthResult<T> | null {
    const expectedState = this.getPendingState();
    if(!expectedState)
      return null;

    const resultStorageKey = this.getResultStorageKey(expectedState);
    let rawEnvelope: string | null;
    try {
      rawEnvelope = localStorage.getItem(resultStorageKey);
      if(rawEnvelope === null)
        return null;
    } catch(error) {
      console.error(`Could not read ${this.authModule} authentication result.`, error);
      return null;
    }

    return this.parseStoredEnvelope(rawEnvelope, resultStorageKey);
  }

  private processMessage(event: MessageEvent<unknown>): void {
    if(!this.popup || !this.expectedOrigin || event.origin !== this.expectedOrigin || event.source !== this.popup)
      return;

    const expectedState = this.getPendingState();
    if(!expectedState)
      return;
    const authResult = this.consumeEnvelope(event.data, this.getResultStorageKey(expectedState));
    if(!authResult)
      return;

    this.finish(authResult);
  }

  private processStorage(event: StorageEvent): void {
    const expectedState = this.getPendingState();
    if(!expectedState)
      return;

    const resultStorageKey = this.getResultStorageKey(expectedState);
    if(event.storageArea !== localStorage || event.key !== resultStorageKey || event.newValue === null)
      return;

    const authResult = this.parseStoredEnvelope(event.newValue, resultStorageKey);
    if(!authResult)
      return;

    this.finish(authResult);
  }

  private finish(authResult: AuthResult<T>): void {
    this.clearPollTimer();
    if(this.popup) {
      try {
        this.popup.close();
      } catch {}
    }
    this.popup = null;
    this.expectedOrigin = null;
    this.onPopupState(false);
    this.onResult(authResult);
  }

  private parseStoredEnvelope(rawEnvelope: string, resultStorageKey: string): AuthResult<T> | null {
    try {
      return this.consumeEnvelope(JSON.parse(rawEnvelope), resultStorageKey);
    } catch(error) {
      try {
        localStorage.removeItem(resultStorageKey);
      } catch {}
      console.error(`Could not parse ${this.authModule} authentication result.`, error);
      return null;
    }
  }

  private pollPopupState(): void {
    if(!this.popup)
      return;

    if(this.popup.closed) {
      this.cancel();
      this.popup = null;
      this.expectedOrigin = null;
      this.popupPollTimer = null;
      this.onPopupState(false);
      return;
    }

    this.popupPollTimer = window.setTimeout(() => this.pollPopupState(), 1000);
  }

  private clearPollTimer(): void {
    if(this.popupPollTimer === null)
      return;
    window.clearTimeout(this.popupPollTimer);
    this.popupPollTimer = null;
  }

  public acceptRecoveredEnvelope(value: unknown): boolean {
    const expectedState = this.getPendingState();
    if(!expectedState)
      return false;

    const authResult = this.consumeEnvelope(value, this.getResultStorageKey(expectedState));
    if(!authResult)
      return false;

    this.finish(authResult);
    return true;
  }

  private consumeEnvelope(value: unknown, resultStorageKey: string | null): AuthResult<T> | null {
    if(!this.isEnvelope(value))
      return null;

    const expectedState = this.getPendingState();
    if(expectedState === null || value.authState !== expectedState)
      return null;

    try {
      sessionStorage.removeItem(this.stateStorageKey);
    } catch(error) {
      console.error(`Could not consume ${this.authModule} authentication state.`, error);
      return null;
    }

    if(resultStorageKey) {
      try {
        localStorage.removeItem(resultStorageKey);
      } catch(error) {
        console.error(`Could not clear ${this.authModule} authentication result.`, error);
      }
    }
    return value.authResult;
  }

  public getPendingState(): string | null {
    try {
      const state = sessionStorage.getItem(this.stateStorageKey);
      return state && AUTH_STATE_PATTERN.test(state) ? state : null;
    } catch(error) {
      console.error(`Could not read ${this.authModule} authentication state.`, error);
      return null;
    }
  }

  private getResultStorageKey(state: string): string {
    return `${this.authModule}.AuthResult.${state}`;
  }

  private isEnvelope(value: unknown): value is AuthEnvelope<T> {
    if(!isRecord(value) || Object.keys(value).length !== 3)
      return false;

    return value.authModule === this.authModule
      && typeof value.authState === "string"
      && AUTH_STATE_PATTERN.test(value.authState)
      && isAuthResult(value.authResult, this.isData);
  }
}
