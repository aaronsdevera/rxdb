import type {
    RxJsonSchema,
    RxDocument,
    MigrationStrategies
} from './';
import type {
    RxCollectionBase
} from '../rx-collection';
import type { QueryCache } from '../query-cache';
import { RxLocalDocumentMutation } from './rx-database';

export interface KeyFunctionMap {
    [key: string]: Function;
}
export interface NumberFunctionMap {
    [key: number]: Function;
}


/**
 * Params to create a new collection.
 * Notice the name of the collection is set onle level higher
 * when calling addCollections()
 */
export type RxCollectionCreator = {
    schema: RxJsonSchema<any>;
    instanceCreationOptions?: any;
    migrationStrategies?: MigrationStrategies;
    autoMigrate?: boolean;
    statics?: KeyFunctionMap;
    methods?: KeyFunctionMap;
    attachments?: KeyFunctionMap;
    options?: any;
    cacheReplacementPolicy?: RxCacheReplacementPolicy;
}

export interface MigrationState {
    done: boolean; // true if finished
    total: number; // will be the doc-count
    handled: number; // amount of handled docs
    success: number; // handled docs which successed
    deleted: number; // handled docs which got deleted
    percent: number; // percentage
}


export type RxCacheReplacementPolicy = (collection: RxCollection, queryCache: QueryCache) => void;

export type RxCollectionHookCallback<
    RxDocumentType,
    OrmMethods
    > = (
        data: RxDocumentType,
        instance: RxDocument<RxDocumentType, OrmMethods>
    ) => void | Promise<void> | any;
export type RxCollectionHookNoInstance<RxDocumentType> = (data: RxDocumentType) => void | Promise<void> | any;
export type RxCollectionHookCallbackNonAsync<RxDocumentType, OrmMethods> = (
    data: RxDocumentType,
    instance: RxDocument<RxDocumentType, OrmMethods>
) => void | any;
export type RxCollectionHookNoInstanceCallback<
    RxDocumentType,
    OrmMethods
    > = (
        data: RxDocumentType,
        instance: RxCollection<RxDocumentType, OrmMethods>
    ) => Promise<void> | void | any;

export type RxCollection<
    RxDocumentType = any,
    OrmMethods = {},
    StaticMethods = {},
    InstanceCreationOptions = {}
    > = StaticMethods &
    RxCollectionBase<InstanceCreationOptions, RxDocumentType, OrmMethods> &
    RxCollectionGenerated<RxDocumentType, OrmMethods>;

export interface RxCollectionGenerated<RxDocumentType = any, OrmMethods = {}> extends RxLocalDocumentMutation<RxCollection<RxDocumentType, OrmMethods>> {

    // HOOKS
    preInsert(fun: RxCollectionHookNoInstanceCallback<RxDocumentType, OrmMethods>, parallel: boolean): void;
    preSave(fun: RxCollectionHookCallback<RxDocumentType, OrmMethods>, parallel: boolean): void;
    preRemove(fun: RxCollectionHookCallback<RxDocumentType, OrmMethods>, parallel: boolean): void;
    postInsert(fun: RxCollectionHookCallback<RxDocumentType, OrmMethods>, parallel: boolean): void;
    postSave(fun: RxCollectionHookCallback<RxDocumentType, OrmMethods>, parallel: boolean): void;
    postRemove(fun: RxCollectionHookCallback<RxDocumentType, OrmMethods>, parallel: boolean): void;
    postCreate(fun: RxCollectionHookCallbackNonAsync<RxDocumentType, OrmMethods>): void;

    // only inMemory-collections
    awaitPersistence(): Promise<void>;
}

/**
 * Properties are possibly encrypted so type them as any.
 */
export type RxDumpCollectionAsAny<T> = { [P in keyof T]: any };

interface RxDumpCollectionBase {
    encrypted: boolean;
    name: string;
    passwordHash: string | null;
    schemaHash: string;
}
export interface RxDumpCollection<RxDocumentType> extends RxDumpCollectionBase {
    docs: RxDocumentType[];
}
/**
 * All base properties are typed as any because they can be encrypted.
 */
export interface RxDumpCollectionAny<RxDocumentType> extends RxDumpCollectionBase {
    docs: RxDumpCollectionAsAny<RxDocumentType>[];
}
