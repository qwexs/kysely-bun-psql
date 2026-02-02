# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
