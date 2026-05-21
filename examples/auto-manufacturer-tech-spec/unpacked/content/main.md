# Orion Apex Motors Technical Specification Dossier

This synthetic MCD package models a large technical specification dossier for a fictional auto manufacturer. The document combines plain engineering specification text with canonical CSV-backed data tables so parser tests can exercise large row counts without depending on real manufacturer data.

All measurements are synthetic but realistic enough for validation, rendering, extraction, and AI ingestion scenarios. Values are intentionally varied across platforms, regions, propulsion systems, battery packs, chassis tests, and manufacturing lots.

## Engineering Calculation Basis

Aerodynamic drag is estimated as $F_d = 0.5 \rho C_d A v^2$, where $\rho$ is air density, $C_d$ is drag coefficient, $A$ is frontal area, and $v$ is vehicle speed.

Powertrain power is checked with $P_{kW} = T_{Nm} \omega_{rpm} / 9549$, and tractive effort at the axle is approximated by $F_t = T_e G_f G_g \eta / r_t$.

Battery nominal energy follows $E_{kWh} = V_{nom} C_{Ah} N_p / 1000$. Pack thermal sizing uses $Q_{coolant} = \dot{m} c_p \Delta T$ for first-pass heat rejection.

Brake energy for a single 100-0 km/h stop is approximated by $E_b = 0.5 m v^2$, and required average deceleration is $a = v^2 / (2s)$.

Production capability tracking uses $C_p = (USL - LSL) / (6\sigma)$ and defects-per-million tracking as $DPMO = defects / opportunities \times 1,000,000$.

## Specification Notes

The specification assumes a modular platform strategy with shared architecture codes, region-specific homologation releases, software-controlled torque limits, and traceable lot-level production status. A row is one released configuration, calibration, validation test, battery specification, or production lot depending on the table.

Column units are declared in each table view where applicable. Nullable cells are avoided to keep strict typed-table validation simple for load and extraction tests.

## Vehicle variant configuration specifications

Configuration release sheet for body, drivetrain, mass, drag, payload, and homologation attributes.

The table contains 1000 synthetic specification rows. It is placed as a canonical MCD table and should be used as the source of truth for any rendered view, extraction flow, or downstream computation.

:::table
ref: vehicle_variant_configuration_specs-table
table: vehicle_variant_configuration_specs
view: default
display: table
caption: Vehicle variant configuration specifications
numbering: auto
:::

## Powertrain calibration specifications

Engine and hybrid control calibrations for power, torque, final drive, emissions, and thermal release limits.

The table contains 1000 synthetic specification rows. It is placed as a canonical MCD table and should be used as the source of truth for any rendered view, extraction flow, or downstream computation.

:::table
ref: powertrain_calibration_specs-table
table: powertrain_calibration_specs
view: default
display: table
caption: Powertrain calibration specifications
numbering: auto
:::

## Battery pack and module specifications

High-voltage battery architecture records covering chemistry, cell grouping, usable energy, charge power, and cooling flow.

The table contains 1000 synthetic specification rows. It is placed as a canonical MCD table and should be used as the source of truth for any rendered view, extraction flow, or downstream computation.

:::table
ref: battery_pack_module_specs-table
table: battery_pack_module_specs
view: default
display: table
caption: Battery pack and module specifications
numbering: auto
:::

## Chassis and brake validation specifications

Vehicle dynamics validation records for springs, damping, brake sizing, stopping distance, lateral grip, and stability margin.

The table contains 1000 synthetic specification rows. It is placed as a canonical MCD table and should be used as the source of truth for any rendered view, extraction flow, or downstream computation.

:::table
ref: chassis_brake_validation_specs-table
table: chassis_brake_validation_specs
view: default
display: table
caption: Chassis and brake validation specifications
numbering: auto
:::

## Production quality measurements

Final assembly quality lots for torque, paint, closure fit, leak checks, battery health, and release status.

The table contains 1000 synthetic specification rows. It is placed as a canonical MCD table and should be used as the source of truth for any rendered view, extraction flow, or downstream computation.

:::table
ref: production_quality_measurements-table
table: production_quality_measurements
view: default
display: table
caption: Production quality measurements
numbering: auto
:::
