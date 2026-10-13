export function assertMeasuredQualityGate({ gate, measures }) {
  const value = (metric) => {
    const entry = measures.find((item) => item.metric === metric);
    return entry && entry.value !== "" ? Number(entry.value) : NaN;
  };
  if (gate.status !== "OK")
    throw new Error("SonarQube quality gate did not pass");
  if (!Number.isFinite(value("ncloc")) || value("ncloc") <= 0)
    throw new Error("SonarQube indexed no measurable source code");
  if (
    !Number.isFinite(value("coverage")) ||
    value("coverage") < 80 ||
    value("coverage") > 100
  )
    throw new Error(
      "SonarQube coverage is missing or below the required 80% gate",
    );
  if (value("security_hotspots") !== 0)
    throw new Error(
      "SonarQube security hotspot evidence is missing or not zero",
    );
}
