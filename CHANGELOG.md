# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-08-10

### Added

- `BunDialectConfig.bigint` forwards Bun SQL's `bigint` option. Opt in with `bigint: true` to receive PostgreSQL integer values outside the signed `int32` range as exact JavaScript `bigint` values; the existing default remains unchanged.

## [1.2.0] - 2026-06-22

### Fixed

- `executeQuery` now reports real `numAffectedRows` for INSERT/UPDATE/DELETE without a `RETURNING` clause by reading `result.count` from `bun:postgres` instead of `result.values().length` (was always `0n`). Fixes [#6](https://github.com/qwexs/kysely-bun-psql/issues/6).

### Changed

- Updated `@ratiu5` references in source/docs to `@qwexs`.

## [1.0.0] - 2025-02-02

### Added

- `jsonbArray()` helper function for proper JSONB[] column handling
- Full pool configuration support (max, idleTimeout, maxLifetime, connectionTimeout)

### Fixed

- Proper handling of JSONB vs JSONB[] columns
- Array serialization for JSONB fields
- Connection pool options now correctly passed to Bun.SQL constructor
- Use `release()` instead of `close()` for reserved connections

### Changed

- Forked from `@ratiu5/kysely-bun-psql` and republished as `@qwexs/kysely-bun-psql`
- Production-ready release

## Prior History

This package is a fork of [@ratiu5/kysely-bun-psql](https://github.com/RATIU5/kysely-bun-psql), 
which was originally based on work by Igal Klebanov.
