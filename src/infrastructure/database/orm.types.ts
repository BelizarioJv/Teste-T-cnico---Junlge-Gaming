import type {
  AnyEntity,
  EntityClass,
  EntityManager,
  EntitySchema,
  IDatabaseDriver,
  MikroORM,
} from '@mikro-orm/core';

export type ApplicationOrm = MikroORM<
  IDatabaseDriver,
  EntityManager<IDatabaseDriver>,
  readonly (string | EntityClass<AnyEntity> | EntitySchema)[]
>;
