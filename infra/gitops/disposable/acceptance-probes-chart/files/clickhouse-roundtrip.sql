CREATE TEMPORARY TABLE greenguard_acceptance_probe
(
    marker String
)
ENGINE = Memory;

INSERT INTO greenguard_acceptance_probe VALUES ('greenguard-clickhouse-roundtrip-v1');

SELECT throwIf(
    count() != 1 OR any(marker) != 'greenguard-clickhouse-roundtrip-v1',
    'ClickHouse acceptance insert/select round-trip failed'
)
FROM greenguard_acceptance_probe;
