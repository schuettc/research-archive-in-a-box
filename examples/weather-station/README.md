# Daily weather at the field station

Daily highest and lowest air temperature, rainfall and mean wind speed at an invented field station for the first three weeks of June 2024. Every value is invented.

This README is generated from `datapackage.json`. Edit the manifest, not this file.

## Citation

Invented Research Cooperative. Daily weather at the field station. Version 1. `weather-station`.

## Creators

- Invented Research Cooperative

## Rights

- Licensed CC-BY-4.0 (Creative Commons Attribution 4.0 International): <https://creativecommons.org/licenses/by/4.0/>

## About

- **Access:** public
- **Keywords:** weather, air temperature, rainfall, wind
- **Temporal coverage:** 2024-06-01 to 2024-06-21
- **Spatial coverage:** west -72.73, south 44.26, east -72.72, north 44.27. One invented field station.

## Resources

### `daily`: Daily weather

Kind: table. File: `data/daily.csv`.

One row per day.

| Column           | Title                       | Type   | Description                                                           | Codes | Unit | Scale    |
| ---------------- | --------------------------- | ------ | --------------------------------------------------------------------- | ----- | ---- | -------- |
| `date`           | Date                        | date   | The day, midnight to midnight local standard time.                    |       |      | dateTime |
| `air_temp_max_c` | Highest air temperature (C) | number | Highest air temperature of the day at 2 m, in degrees Celsius.        |       | degC | interval |
| `air_temp_min_c` | Lowest air temperature (C)  | number | Lowest air temperature of the day at 2 m, in degrees Celsius.         |       | degC | interval |
| `rain_mm`        | Rainfall (mm)               | number | Rain caught by the tipping-bucket gauge over the day, in millimetres. |       | mm   | ratio    |
| `wind_speed_m_s` | Mean wind speed (m/s)       | number | Mean wind speed over the day at 3 m, in metres per second.            |       | m/s  | ratio    |
