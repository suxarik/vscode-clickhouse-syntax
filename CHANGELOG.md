# Changelog

All notable changes to the ClickHouse SQL Syntax extension will be documented in this file.

## [1.0.0] - 2024-02-26

### Added
- Initial release
- Syntax highlighting for ClickHouse SQL dialect
  - ClickHouse-specific data types (UInt8–UInt256, Int8–Int256, Float32/64, Decimal variants, String, FixedString, Date/DateTime/DateTime64, Array, Tuple, Map, Nested, Nullable, LowCardinality, UUID, IPv4, IPv6, Bool, Enum8/16)
  - Table engines (MergeTree family, Distributed, Buffer, Kafka, S3, HDFS, and more)
  - 400+ ClickHouse functions (aggregate, array, string, date/time, math, type conversion, conditional, geospatial, bitmap)
  - ClickHouse-specific keywords (PREWHERE, SAMPLE, FINAL, FORMAT, SETTINGS, TTL, CODEC, DEDUPLICATE, etc.)
  - Standard SQL keywords, operators, comments, strings, numbers
- Grammar injection into standard `.sql` files for seamless integration
- 40+ code snippets for common ClickHouse patterns
- Hover documentation for frequently-used ClickHouse functions
- Auto-completion for keywords, functions, and data types
- SQL formatter with configurable keyword case and indent size
- Language configuration (brackets, comments, auto-closing pairs, folding)
- Support for `.chsql` and `.ch.sql` file extensions
