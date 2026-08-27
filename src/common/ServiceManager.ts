
export class ServiceManager {
  private static _serviceSymbol = (globalThis.Symbol ? Symbol("ServiceInstances") : "__SvcInstances");
  private static _serviceClasses: object[] = [];
  private static _serviceInstances: object[][][] = [];
  private static _disposePromise: Promise<void> | null = null;
  private static _disposeBatchInstances: Set<object[]> | null = null;
  private static _serviceDisposePromises = new WeakMap<object[], Promise<void>>();
  private static _serviceRemovalPromises = new WeakMap<object[], Promise<void>>();

  private static GetServiceIdx<SvcT extends object, SvcP = any>(serviceClass: new(props: SvcP) => SvcT): number {
    let serviceIdx: number;

    if(serviceClass.hasOwnProperty(this._serviceSymbol))
      serviceIdx = serviceClass[this._serviceSymbol];
    else {
      serviceIdx = this._serviceClasses.length;
      Object.defineProperty(serviceClass, this._serviceSymbol, {
        value: serviceIdx,
        writable: false
      });
      this._serviceClasses.push(serviceClass);
      this._serviceInstances.push([]);
    }

    return serviceIdx;
  }

  private static GetServiceObj(serviceIdx: number, identObj: object): object {
    let objListLen = this._serviceInstances[serviceIdx].length;
    for(let idx = 0; idx < objListLen; idx++) {
      if(this._serviceInstances[serviceIdx][idx][0] === identObj)
        return this._serviceInstances[serviceIdx][idx][1];
    }
    return null;
  }

  private static AddServiceObj(serviceIdx: number, identObj: object, serviceObj: object) {
    this._serviceInstances[serviceIdx].push([
      identObj,
      serviceObj
    ]);
  }

  public static GetService<SvcT extends object, SvcP = any>(serviceClass: new(props: SvcP) => SvcT, serviceIdent: object = null, serviceProps: SvcP = null): SvcT {
    if(!serviceClass)
      return null;

    let serviceIdx = this.GetServiceIdx(serviceClass);
    let serviceObj = this.GetServiceObj(serviceIdx, serviceIdent) as SvcT;
    if(!serviceObj) {
      serviceObj = new serviceClass(serviceProps);
      this.AddServiceObj(serviceIdx, serviceIdent, serviceObj);
    }

    return serviceObj;
  }

  public static DisposeAllServices(): Promise<void> {
    if(this._disposePromise)
      return this._disposePromise;

    const snapshot = this._serviceInstances.map((instances) => instances.slice());
    const batchInstances = new Set(snapshot.flat());
    this._disposeBatchInstances = batchInstances;
    const disposal = this.disposeServices(snapshot).finally(() => {
      if(this._disposePromise === disposal) {
        this._disposePromise = null;
        if(this._disposeBatchInstances === batchInstances)
          this._disposeBatchInstances = null;
      }
    });
    this._disposePromise = disposal;
    return disposal;
  }

  public static DisposeService<SvcT extends object, SvcP = any>(
    serviceClass: new(props: SvcP) => SvcT,
    serviceIdent: object = null,
  ): Promise<void> {
    if(!serviceClass || !serviceClass.hasOwnProperty(this._serviceSymbol))
      return Promise.resolve();

    const serviceIdx = serviceClass[this._serviceSymbol] as number;
    const instance = this._serviceInstances[serviceIdx]?.find((entry) => entry[0] === serviceIdent);
    if(!instance)
      return Promise.resolve();

    const existingRemoval = this._serviceRemovalPromises.get(instance);
    if(existingRemoval)
      return existingRemoval;

    const removal = this.disposeService(instance).finally(() => {
      if(!this._disposeBatchInstances?.has(instance))
        this.removeServiceInstance(serviceIdx, instance);
    });
    this._serviceRemovalPromises.set(instance, removal);
    return removal;
  }

  private static async disposeServices(snapshot: object[][][]): Promise<void> {
    const instances = snapshot.flatMap((serviceInstances, serviceIdx) => {
      return serviceInstances.map((instance) => ({ serviceIdx, instance }));
    });
    const results = await Promise.allSettled(instances.map(({ instance }) => {
      return this.disposeService(instance);
    }));

    for(const { serviceIdx, instance } of instances)
      this.removeServiceInstance(serviceIdx, instance);

    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if(errors.length > 0)
      throw new AggregateError(errors, "One or more services failed to stop cleanly");
  }

  private static disposeService(instance: object[]): Promise<void> {
    const existingDisposal = this._serviceDisposePromises.get(instance);
    if(existingDisposal)
      return existingDisposal;

    const serviceObj = instance[1];
    const disposal = Promise.resolve().then(async () => {
      const dispose = (serviceObj as any).dispose;
      if(typeof dispose === "function")
        await dispose.call(serviceObj);
    });
    this._serviceDisposePromises.set(instance, disposal);
    return disposal;
  }

  private static removeServiceInstance(serviceIdx: number, instance: object[]): void {
    const currentInstances = this._serviceInstances[serviceIdx];
    const instanceIdx = currentInstances.indexOf(instance);
    if(instanceIdx !== -1)
      currentInstances.splice(instanceIdx, 1);
    this._serviceDisposePromises.delete(instance);
    this._serviceRemovalPromises.delete(instance);
  }

}
