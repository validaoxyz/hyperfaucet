import { default as nodeFetch, RequestInfo, RequestInit, Response } from 'node-fetch';

export const DEFAULT_JSON_RESPONSE_LIMIT = 64 * 1024;

export interface BoundedJsonFetchOptions {
    init?: RequestInit;
    timeoutMs?: number;
    maxResponseBytes?: number;
}

interface TimedFetchResult {
    response: Response;
    didTimeOut: () => boolean;
}

export class FetchUtil {
    public static fetch(
        url: RequestInfo,
        init?: RequestInit,
    ): Promise<Response> {
        if(init)
            return nodeFetch(url, init);
        else
            return nodeFetch(url);
    }

    public static fetchWithTimeout(
        url: RequestInfo,
        init?: RequestInit,
        timeout: number = 5000,
    ): Promise<Response> {
        return this.startTimedFetch(url, init, timeout).then((result) => result.response);
    }

    public static async fetchBoundedJson(
        url: RequestInfo,
        options: BoundedJsonFetchOptions = {},
    ): Promise<unknown> {
        const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_JSON_RESPONSE_LIMIT;
        this.requirePositiveInteger(maxResponseBytes, "maxResponseBytes");

        const result = await this.startTimedFetch(url, {
            ...(options.init || {}),
            size: maxResponseBytes,
        }, options.timeoutMs ?? 5000);

        try {
            return await result.response.json();
        } catch(error) {
            if(result.didTimeOut())
                throw new Error("Request timed out");
            throw error;
        }
    }

    private static async startTimedFetch(
        url: RequestInfo,
        init: RequestInit | undefined,
        timeout: number,
    ): Promise<TimedFetchResult> {
        this.requirePositiveInteger(timeout, "timeout");

        const timeoutController = new AbortController();
        const callerSignal = init?.signal;
        const abortFromCaller = () => timeoutController.abort();
        let timedOut = false;
        let cleanedUp = false;
        let responseBody: NodeJS.ReadableStream | null = null;

        const cleanup = () => {
            if(cleanedUp)
                return;
            cleanedUp = true;
            clearTimeout(timeoutId);
            callerSignal?.removeEventListener("abort", abortFromCaller);
            responseBody?.removeListener("end", cleanup);
            responseBody?.removeListener("close", cleanup);
            responseBody?.removeListener("error", cleanup);
        };

        if(callerSignal?.aborted)
            timeoutController.abort();
        else
            callerSignal?.addEventListener("abort", abortFromCaller);

        const timeoutId = setTimeout(() => {
            timedOut = true;
            timeoutController.abort();
        }, timeout);

        let response: Response;
        try {
            response = await FetchUtil.fetch(url, {
                ...(init || {}),
                signal: timeoutController.signal,
            });
        } catch(error) {
            cleanup();
            if(timedOut)
                throw new Error("Request timed out");
            throw error;
        }

        responseBody = response.body;
        if(responseBody) {
            responseBody.once("end", cleanup);
            responseBody.once("close", cleanup);
            responseBody.once("error", cleanup);
            const bodyState = responseBody as NodeJS.ReadableStream & {
                destroyed?: boolean;
                readableEnded?: boolean;
            };
            if(bodyState.destroyed || bodyState.readableEnded)
                cleanup();
        } else {
            cleanup();
        }

        return {
            response,
            didTimeOut: () => timedOut,
        };
    }

    private static requirePositiveInteger(value: number, name: string): void {
        if(!Number.isSafeInteger(value) || value <= 0)
            throw new TypeError(`${name} must be a positive integer`);
    }
}
