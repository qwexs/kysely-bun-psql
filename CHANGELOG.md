# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - Unreleased

### Changed

- Target the latest stable Bun (currently 1.4.4), with matching Bun types and a single CI runtime; older Bun versions are no longer supported.
- Require Kysely `>=0.29.7 <0.30` for current driver, savepoint and cancellation interfaces.
- Pass array parameters through to Bun's native serializer instead of constructing PostgreSQL array literals.
- Return honest Kysely `RawBuilder` expressions from `jsonb()` and `jsonbArray()`; inputs are no longer mutated. Deprecate the inert `JSONB_SYMBOL` export.
- Encode `jsonbArray()` null elements as JSON null; use undefined for SQL NULL. Nested JS arrays are individual JSON values.
- Run PostgreSQL integration tests against `postgres:latest` with health checks and isolated fixture schemas.
- Validate release tags, tests, and the built package before publishing; create the GitHub release only after npm publication succeeds.

### Fixed

- Await Bun SQL's asynchronous reserved-connection release, including propagating release failures to Kysely callers.
- Preserve multidimensional arrays and allow frozen values, JSON scalars and JSON null in `jsonb()`.
- Honor transaction access modes and report affected rows for MERGE using Bun's native metadata.
- Make integration test commands prepare their fixtures consistently, close clients, and test real handshake timeouts and refused connections.

### Added

- Native `sql.json()` / `sql.array()` helpers and `pgArray()` for typed arrays and custom PostgreSQL array types.
- PostgreSQL configuration derived from Bun options: prepared statements, startup parameters, async passwords, sockets, TLS, channel binding and explicit result transforms.
- Shared native `SQL` clients, caller-owned by default, with optional ownership transfer and bounded owned-pool shutdown (`closeTimeout`).
- Abortable native pool reservation and Kysely's opt-in running-query cancellation using Bun's `query.cancel()`; preserve default `ignore query` behavior and hold reservations until native work settles.
- Quoted savepoints for Kysely controlled transactions and transaction isolation validation.
- Passing regression coverage for multidimensional arrays, MERGE counts, read-only transactions and frozen JSON values, plus native runtime integration scenarios.
- Integration coverage for concurrent sessions, transaction isolation and recovery, pool reuse, zero/multiple affected rows, and upserts.
- Published-tarball smoke tests for isolated installation, runtime exports, and consumer type checking.

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
