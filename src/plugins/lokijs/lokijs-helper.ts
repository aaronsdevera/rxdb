import { createLokiLocalState, RxStorageInstanceLoki } from './rx-storage-instance-loki';
import {
    createLokiKeyValueLocalState,
    RxStorageKeyObjectInstanceLoki
} from './rx-storage-key-object-instance-loki';
import lokijs, { Collection } from 'lokijs';
import type {
    LokiDatabaseSettings,
    LokiDatabaseState,
    LokiLocalDatabaseState,
    LokiRemoteResponseBroadcastMessage,
    MangoQuery,
    MangoQuerySortDirection,
    MangoQuerySortPart,
    RxJsonSchema
} from '../../types';
import {
    add as unloadAdd, AddReturn
} from 'unload';
import { ensureNotFalsy, flatClone, promiseWait, randomCouchString } from '../../util';
import { LokiSaveQueue } from './loki-save-queue';
import type { DeterministicSortComparator } from 'event-reduce-js';
import { getPrimaryFieldOfPrimaryKey } from '../../rx-schema';
import { newRxError } from '../../rx-error';
import {
    BroadcastChannel,
    createLeaderElection,
    LeaderElector,
    OnMessageHandler
} from 'broadcast-channel';
import type { RxStorageLoki } from './rx-storage-lokijs';

export const CHANGES_COLLECTION_SUFFIX = '-rxdb-changes';
export const LOKI_BROADCAST_CHANNEL_MESSAGE_TYPE = 'rxdb-lokijs-remote-request';
export const LOKI_KEY_OBJECT_BROADCAST_CHANNEL_MESSAGE_TYPE = 'rxdb-lokijs-remote-request-key-object';


/**
 * Loki attaches a $loki property to all data
 * which must be removed before returning the data back to RxDB.
 */
export function stripLokiKey<T>(docData: T & { $loki?: number; $lastWriteAt?: number; }): T {
    if (!docData.$loki) {
        return docData;
    }
    const cloned = flatClone(docData);
    delete cloned.$loki;
    delete cloned.$lastWriteAt;
    return cloned;
}

export function getLokiEventKey(
    isLocal: boolean,
    primary: string,
    revision: string
): string {
    const prefix = isLocal ? 'local' : 'non-local';
    const eventKey = prefix + '|' + primary + '|' + revision;
    return eventKey;
}

/**
 * Used to check in tests if all instances have been cleaned up.
 */
export const OPEN_LOKIJS_STORAGE_INSTANCES: Set<RxStorageKeyObjectInstanceLoki | RxStorageInstanceLoki<any>> = new Set();


export const LOKIJS_COLLECTION_DEFAULT_OPTIONS: Partial<CollectionOptions<any>> = {
    disableChangesApi: true,
    disableMeta: true,
    disableDeltaChangesApi: true,
    disableFreeze: true,
    // TODO use 'immutable' like WatermelonDB does it
    cloneMethod: 'shallow-assign',
    clone: false,
    transactional: false,
    autoupdate: false
}

const LOKI_DATABASE_STATE_BY_NAME: Map<string, Promise<LokiDatabaseState>> = new Map();
export function getLokiDatabase(
    databaseName: string,
    databaseSettings: LokiDatabaseSettings
): Promise<LokiDatabaseState> {
    let databaseState: Promise<LokiDatabaseState> | undefined = LOKI_DATABASE_STATE_BY_NAME.get(databaseName);
    if (!databaseState) {
        /**
         * We assume that as soon as an adapter is passed,
         * the database has to be persistend.
         */
        const hasPersistence: boolean = !!databaseSettings.adapter;
        databaseState = (async () => {

            let persistenceMethod = hasPersistence ? 'adapter' : 'memory';
            if (databaseSettings.persistenceMethod) {
                persistenceMethod = databaseSettings.persistenceMethod;
            }
            const useSettings = Object.assign(
                // defaults
                {
                    autoload: hasPersistence,
                    persistenceMethod,
                    verbose: true
                },
                databaseSettings,
                // overwrites
                {
                    /**
                     * RxDB uses its custom load and save handling
                     * so we disable the LokiJS save/load handlers.
                     */
                    autoload: false,
                    autosave: false,
                    throttledSaves: false
                }
            );
            const database = new lokijs(
                databaseName + '.db',
                flatClone(useSettings)
            );
            const lokiSaveQueue = new LokiSaveQueue(
                database,
                useSettings
            );

            /**
             * Wait until all data is loaded from persistence adapter.
             * Wrap the loading into the saveQueue to ensure that when many
             * collections are created a the same time, the load-calls do not interfer
             * with each other and cause error logs.
             */
            if (hasPersistence) {
                const loadDatabasePromise = new Promise<void>((res, rej) => {
                    database.loadDatabase({}, (err) => {
                        if (useSettings.autoloadCallback) {
                            useSettings.autoloadCallback(err);
                        }
                        err ? rej(err) : res();
                    });
                });
                lokiSaveQueue.saveQueue = lokiSaveQueue.saveQueue.then(() => loadDatabasePromise);
                await loadDatabasePromise;
            }

            /**
             * Autosave database on process end
             */
            const unloads: AddReturn[] = [];
            if (hasPersistence) {
                unloads.push(
                    unloadAdd(() => lokiSaveQueue.run())
                );
            }

            const state: LokiDatabaseState = {
                database,
                databaseSettings: useSettings,
                saveQueue: lokiSaveQueue,
                collections: {},
                unloads
            };

            return state;
        })();
        LOKI_DATABASE_STATE_BY_NAME.set(databaseName, databaseState);
    }
    return databaseState;
}

export async function closeLokiCollections(
    databaseName: string,
    collections: Collection[]
) {
    const databaseState = await LOKI_DATABASE_STATE_BY_NAME.get(databaseName);
    if (!databaseState) {
        // already closed
        return;
    }
    await databaseState.saveQueue.run();
    collections.forEach(collection => {
        const collectionName = collection.name;
        delete databaseState.collections[collectionName];
    });
    if (Object.keys(databaseState.collections).length === 0) {
        // all collections closed -> also close database
        LOKI_DATABASE_STATE_BY_NAME.delete(databaseName);
        databaseState.unloads.forEach(u => u.remove());
        await new Promise<void>((res, rej) => {
            databaseState.database.close(err => {
                err ? rej(err) : res();
            });
        });
    }
}

/**
 * This function is at lokijs-helper
 * because we need it in multiple places.
 */
export function getLokiSortComparator<RxDocType>(
    schema: RxJsonSchema<RxDocType>,
    query: MangoQuery<RxDocType>
): DeterministicSortComparator<RxDocType> {
    const primaryKey = getPrimaryFieldOfPrimaryKey(schema.primaryKey);
    // TODO if no sort is given, use sort by primary.
    // This should be done inside of RxDB and not in the storage implementations.
    const sortOptions: MangoQuerySortPart<RxDocType>[] = query.sort ? (query.sort as any) : [{
        [primaryKey]: 'asc'
    }];
    const fun: DeterministicSortComparator<RxDocType> = (a: RxDocType, b: RxDocType) => {
        let compareResult: number = 0; // 1 | -1
        sortOptions.find(sortPart => {
            const fieldName: string = Object.keys(sortPart)[0];
            const direction: MangoQuerySortDirection = Object.values(sortPart)[0];
            const directionMultiplier = direction === 'asc' ? 1 : -1;
            const valueA: any = (a as any)[fieldName];
            const valueB: any = (b as any)[fieldName];
            if (valueA === valueB) {
                return false;
            } else {
                if (valueA > valueB) {
                    compareResult = 1 * directionMultiplier;
                    return true;
                } else {
                    compareResult = -1 * directionMultiplier;
                    return true;
                }
            }
        });

        /**
         * Two different objects should never have the same sort position.
         * We ensure this by having the unique primaryKey in the sort params
         * at this.prepareQuery()
         */
        if (!compareResult) {
            throw newRxError('SNH', { args: { query, a, b } });
        }

        return compareResult as any;
    }
    return fun;
}


export function getLokiLeaderElector(
    storage: RxStorageLoki,
    databaseName: string
): LeaderElector {
    let electorState = storage.leaderElectorByLokiDbName.get(databaseName);
    if (!electorState) {
        const channelName = 'rxdb-lokijs-' + databaseName;
        const channel = new BroadcastChannel(channelName);
        const elector = createLeaderElection(channel);
        electorState = {
            leaderElector: elector,
            intancesCount: 1
        }
        storage.leaderElectorByLokiDbName.set(databaseName, electorState);
    } else {
        electorState.intancesCount = electorState.intancesCount + 1;
    }
    return electorState.leaderElector;
}

export function removeLokiLeaderElectorReference(
    storage: RxStorageLoki,
    databaseName: string
) {
    const electorState = storage.leaderElectorByLokiDbName.get(databaseName);
    if (electorState) {
        electorState.intancesCount = electorState.intancesCount - 1;
        if (electorState.intancesCount === 0) {
            electorState.leaderElector.broadcastChannel.close();
            storage.leaderElectorByLokiDbName.delete(databaseName);
        }
    }
}

/**
 * For multi-instance usage, we send requests to the RxStorage
 * to the current leading instance over the BroadcastChannel.
 */
export async function requestRemoteInstance(
    instance: RxStorageInstanceLoki<any> | RxStorageKeyObjectInstanceLoki,
    operation: string,
    params: any[]
): Promise<any | any[]> {
    const isRxStorageInstanceLoki = typeof (instance as any).query === 'function';
    const messageType = isRxStorageInstanceLoki ? LOKI_BROADCAST_CHANNEL_MESSAGE_TYPE : LOKI_KEY_OBJECT_BROADCAST_CHANNEL_MESSAGE_TYPE;

    const leaderElector = ensureNotFalsy(instance.internals.leaderElector);
    await waitUntilHasLeader(leaderElector);
    const broadcastChannel = leaderElector.broadcastChannel;

    type WinningPromise = {
        retry: boolean,
        result?: any;
        error?: any;
    }

    let whenDeathListener: OnMessageHandler<any>;
    const leaderDeadPromise = new Promise<WinningPromise>(res => {
        whenDeathListener = (msg: any) => {
            if (msg.context === 'leader' && msg.action === 'death') {
                res({
                    retry: true
                });
            }
        };
        broadcastChannel.addEventListener('internal', whenDeathListener);
    });
    const requestId = randomCouchString(12);
    let responseListener: OnMessageHandler<any>;
    const responsePromise = new Promise<WinningPromise>((res, _rej) => {
        responseListener = (msg: any) => {
            if (
                msg.type === messageType &&
                msg.response === true &&
                msg.requestId === requestId
            ) {
                if (msg.isError) {
                    res({
                        retry: false,
                        error: msg.result
                    });
                } else {
                    res({
                        retry: false,
                        result: msg.result
                    });
                }
            }
        };
        broadcastChannel.addEventListener('message', responseListener);
    });

    // send out the request to the other instance
    broadcastChannel.postMessage({
        response: false,
        type: messageType,
        operation,
        params,
        requestId,
        databaseName: instance.databaseName,
        collectionName: instance.collectionName
    });


    return Promise.race([
        leaderDeadPromise,
        responsePromise
    ]).then(firstResolved => {
        // clean up listeners
        broadcastChannel.removeEventListener('message', responseListener);
        broadcastChannel.removeEventListener('internal', whenDeathListener);

        if (firstResolved.retry) {
            /**
             * The leader died while a remote request was running
             * we re-run the whole operation.
             * We cannot just re-run requestRemoteInstance()
             * because the current instance might be the new leader now
             * and then we have to use the local state instead of requesting the remote.
             */
            return (instance as any)[operation](...params);
        } else {
            if (firstResolved.error) {
                throw firstResolved.error;
            } else {
                return firstResolved.result;
            }
        }
    });
}

/**
 * Handles a request that came from a remote instance via requestRemoteInstance()
 * Runs the requested operation over the local db instance and sends back the result.
 */
export async function handleRemoteRequest(
    instance: RxStorageInstanceLoki<any> | RxStorageKeyObjectInstanceLoki,
    msg: any
) {
    const isRxStorageInstanceLoki = typeof (instance as any).query === 'function';
    const messageType = isRxStorageInstanceLoki ? LOKI_BROADCAST_CHANNEL_MESSAGE_TYPE : LOKI_KEY_OBJECT_BROADCAST_CHANNEL_MESSAGE_TYPE;

    if (
        msg.type === messageType &&
        msg.requestId &&
        msg.databaseName === instance.databaseName &&
        msg.collectionName === instance.collectionName &&
        !msg.response
    ) {
        const operation = (msg as any).operation;
        const params = (msg as any).params;
        let result: any;
        let isError = false;
        try {
            result = await (instance as any)[operation](...params);
        } catch (err) {
            isError = true;
            result = err;
        }
        const response: LokiRemoteResponseBroadcastMessage = {
            response: true,
            requestId: msg.requestId,
            databaseName: instance.databaseName,
            collectionName: instance.collectionName,
            result,
            isError,
            type: msg.type
        };
        ensureNotFalsy(instance.internals.leaderElector).broadcastChannel.postMessage(response);
    }
}


export async function waitUntilHasLeader(leaderElector: LeaderElector) {
    while (
        !leaderElector.hasLeader
    ) {
        await leaderElector.applyOnce();
        await promiseWait(0);
    }
}

/**
 * If the local state must be used, that one is returned.
 * Returns false if a remote instance must be used.
 */
export async function mustUseLocalState(
    instance: RxStorageInstanceLoki<any> | RxStorageKeyObjectInstanceLoki
): Promise<LokiLocalDatabaseState | false> {
    if (instance.closed) {
        return false;
    }

    const isRxStorageInstanceLoki = typeof (instance as any).query === 'function';

    if (instance.internals.localState) {
        return instance.internals.localState;
    }
    const leaderElector = ensureNotFalsy(instance.internals.leaderElector);
    await waitUntilHasLeader(leaderElector);

    /**
     * It might already have a localState after the applying
     * because another subtask also called mustUSeLocalState()
     */
    if (instance.internals.localState) {
        return instance.internals.localState;
    }

    if (
        leaderElector.isLeader &&
        !instance.internals.localState
    ) {
        // own is leader, use local instance
        if (isRxStorageInstanceLoki) {
            instance.internals.localState = createLokiLocalState<any>({
                databaseName: instance.databaseName,
                collectionName: instance.collectionName,
                options: instance.options,
                schema: (instance as RxStorageInstanceLoki<any>).schema,
                multiInstance: instance.internals.leaderElector ? true : false
            }, instance.databaseSettings);
        } else {
            instance.internals.localState = createLokiKeyValueLocalState({
                databaseName: instance.databaseName,
                collectionName: instance.collectionName,
                options: instance.options,
                multiInstance: instance.internals.leaderElector ? true : false
            }, instance.databaseSettings);
        }
        return ensureNotFalsy(instance.internals.localState);
    } else {
        // other is leader, send message to remote leading instance
        return false;
    }
}
