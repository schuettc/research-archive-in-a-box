# Stream invertebrate counts, 2023

Counts of bottom-dwelling invertebrates, by family, from kick-net samples at two invented stream riffles in May and August 2023. Every site and count is invented; a sample package for the research archive.

This README is generated from `datapackage.json`. Edit the manifest, not this file.

## Citation

Invented Research Cooperative. Stream invertebrate counts, 2023. Version 1. `stream-invertebrates`.

## Creators

- Invented Research Cooperative

## Rights

- Licensed CC-BY-4.0 (Creative Commons Attribution 4.0 International): <https://creativecommons.org/licenses/by/4.0/>

## About

- **Access:** public
- **Keywords:** stream invertebrates, benthic macroinvertebrates, kick-net sampling
- **Temporal coverage:** 2023-05-16 to 2023-08-23
- **Spatial coverage:** west -72.74, south 44.23, east -72.7, north 44.27. Two invented riffles on one invented brook.

## Resources

### `counts`: Invertebrate counts

Kind: table. File: `data/counts.csv`.

One row per family, riffle and visit.

| Column         | Title         | Type    | Description                                            | Codes | Unit          | Scale    |
| -------------- | ------------- | ------- | ------------------------------------------------------ | ----- | ------------- | -------- |
| `date`         | Sampling date | date    | The day the riffle was sampled.                        |       |               | dateTime |
| `site`         | Riffle        | string  | Riffle code, R1 or R2.                                 |       |               | nominal  |
| `family`       | Family        | string  | Taxonomic family the animals were identified to.       |       |               | nominal  |
| `common_group` | Common group  | string  | The everyday name of the family's order.               |       |               | nominal  |
| `count`        | Count         | integer | Animals of the family in the 0.25 square metre sample. |       | dimensionless | ratio    |
