# Soil moisture at twelve plots

Volumetric soil water content and soil temperature at 10 cm depth on twelve invented meadow plots, read by hand probe on two days in summer 2024. Every plot and reading is invented.

This README is generated from `datapackage.json`. Edit the manifest, not this file.

## Citation

Invented Research Cooperative. Soil moisture at twelve plots. Version 1. `soil-moisture`.

## Creators

- Invented Research Cooperative

## Rights

- Licensed CC-BY-4.0 (Creative Commons Attribution 4.0 International): <https://creativecommons.org/licenses/by/4.0/>

## About

- **Access:** public
- **Keywords:** soil moisture, soil temperature, meadow plots
- **Temporal coverage:** 2024-06-10 to 2024-07-15
- **Spatial coverage:** west -72.73, south 44.26, east -72.71, north 44.28. Twelve plots in one invented meadow.

## Resources

### `readings`: Probe readings

Kind: table. File: `data/readings.csv`.

One row per plot and visit.

| Column              | Title                | Type   | Description                                                                             | Codes | Unit    | Scale    |
| ------------------- | -------------------- | ------ | --------------------------------------------------------------------------------------- | ----- | ------- | -------- |
| `plot`              | Plot                 | string | Plot code, M01 to M12.                                                                  |       |         | nominal  |
| `date`              | Reading date         | date   | The day the plot was read.                                                              |       |         | dateTime |
| `water_content_pct` | Water content (%)    | number | Volumetric water content: the share of the soil's volume that is water, at 10 cm depth. |       | percent | ratio    |
| `soil_temp_c`       | Soil temperature (C) | number | Soil temperature at 10 cm depth, in degrees Celsius.                                    |       | degC    | interval |
