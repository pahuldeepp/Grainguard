package com.greenguard.stream;

import static com.greenguard.stream.TestData.*;
import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.greenguard.stream.Model.OutRecord;
import com.greenguard.stream.Model.WindowAcc;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class DerivedEventsTest {
  @Test
  void uuidV5MatchesTheRfc4122Vector() {
    UUID dns = UUID.fromString("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    assertEquals("2ed6657d-e927-568b-95e1-2665a8aea6a2", DerivedEvents.uuidV5(dns, "www.example.com").toString());
  }

  private static WindowAcc acc() {
    Operators.StatsAggregate agg = new Operators.StatsAggregate();
    WindowAcc a = agg.createAccumulator();
    agg.add(event(1, 1, 1, T0 + MIN, 20.0, 50.0), a);
    agg.add(event(1, 1, 2, T0 + 2 * MIN, 22.0, null), a);
    return a;
  }

  @Test
  void aggregateIdIsDeterministicAndRevisionIndependent() throws Exception {
    OutRecord first = DerivedEvents.aggregate("agg", acc(), T0, T0 + 10 * MIN, 600_000, 300_000, 1);
    OutRecord again = DerivedEvents.aggregate("agg", acc(), T0, T0 + 10 * MIN, 600_000, 300_000, 2);
    JsonNode a = assertValid(first);
    JsonNode b = assertValid(again);
    assertEquals(a.get("event_id").asText(), b.get("event_id").asText());
    assertEquals(1, a.get("payload").get("revision").asInt());
    assertEquals(2, b.get("payload").get("revision").asInt());
    assertEquals(21.0, a.get("payload").get("temperature_c").get("mean").asDouble());
    assertEquals(1, a.get("payload").get("relative_humidity_percent").get("count").asInt());
    // another window gets another identity
    OutRecord other = DerivedEvents.aggregate("agg", acc(), T0 + 5 * MIN, T0 + 15 * MIN, 600_000, 300_000, 1);
    assertNotEquals(a.get("event_id").asText(), assertValid(other).get("event_id").asText());
  }

  @Test
  void humidityOnlyAggregateHasNullTemperature() throws Exception {
    Operators.StatsAggregate agg = new Operators.StatsAggregate();
    WindowAcc a = agg.add(event(1, 1, 1, T0 + MIN, null, 40.0), agg.createAccumulator());
    JsonNode body = assertValid(DerivedEvents.aggregate("agg", a, T0, T0 + 10 * MIN, 600_000, 300_000, 1));
    assertTrue(body.get("payload").get("temperature_c").isNull());
  }

  @Test
  void aggregateMergeIsOrderIndependent() {
    Operators.StatsAggregate agg = new Operators.StatsAggregate();
    WindowAcc x = agg.add(event(1, 1, 1, T0, 10.0, 30.0), agg.createAccumulator());
    WindowAcc y = agg.add(event(1, 1, 2, T0 + MIN, 30.0, null), agg.createAccumulator());
    WindowAcc xy = agg.merge(copy(x), copy(y));
    WindowAcc yx = agg.merge(copy(y), copy(x));
    assertEquals(xy.count, yx.count);
    assertEquals(xy.tempSum, yx.tempSum);
    assertEquals(xy.lastEventId, yx.lastEventId);
    assertEquals(10.0, xy.tempMin);
    assertEquals(30.0, xy.tempMax);
    assertEquals(1, xy.humN);
    assertSame(x, agg.merge(x, agg.createAccumulator()));
    WindowAcc empty = agg.createAccumulator();
    assertSame(y, agg.merge(empty, y));
    assertSame(x, agg.getResult(x));
  }

  private static WindowAcc copy(WindowAcc a) {
    Operators.StatsAggregate agg = new Operators.StatsAggregate();
    WindowAcc c = agg.createAccumulator();
    c.count = a.count; c.tempN = a.tempN; c.tempMin = a.tempMin; c.tempMax = a.tempMax; c.tempSum = a.tempSum;
    c.humN = a.humN; c.humMin = a.humMin; c.humMax = a.humMax; c.humSum = a.humSum;
    c.lastMs = a.lastMs; c.lastEventId = a.lastEventId; c.lastCorrelation = a.lastCorrelation;
    c.lastTraceparent = a.lastTraceparent; c.tenantId = a.tenantId; c.deviceId = a.deviceId; c.siteId = a.siteId;
    c.binId = a.binId;
    return c;
  }

  @Test
  void dlqRecordsAreBoundedAndSchemaValid() throws Exception {
    Model.Rejection r = TelemetryParser.rejection("bad_json", "d", "greenguard.telemetry.recorded.v1", 2, 40,
        "{oops".getBytes());
    OutRecord out = DerivedEvents.dlq("dlq", r);
    assertValid(out);
    assertEquals("greenguard.telemetry.recorded.v1:2:40", out.key);
    assertEquals("unknown", out.tenantId);
    assertEquals("bad_json", out.reason);
    OutRecord late = DerivedEvents.late("dlq", event(1, 1, 3, T0, 20.0, null));
    assertValid(late);
    assertEquals(tenant(1), late.tenantId);
    assertEquals("late", late.reason);
  }

  @Test
  void anomalyCarriesSourceIdentityAndIsAdvisory() throws Exception {
    OutRecord out = DerivedEvents.anomaly("an", event(1, 1, 9, T0, 30.0, null), "temperature_c", "zscore", 30.0, 20.0,
        0.5, 20.0);
    JsonNode body = assertValid(out);
    assertEquals(uuid(9), body.get("causation_id").asText());
    assertTrue(body.get("payload").get("advisory").asBoolean());
    assertEquals(DerivedEvents.uuidV5("telemetry.anomaly|" + tenant(1) + "|" + device(1) + "|temperature_c|zscore|"
        + uuid(9)).toString(), body.get("event_id").asText());
  }
}
