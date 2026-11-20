# Breeding bird point counts

Ten-minute point counts of breeding birds at five invented forest points over three mornings in June 2024, with the number of each species heard or seen and its distance. Every point and count is invented.

This README is generated from `datapackage.json`. Edit the manifest, not this file.

## Citation

Invented Research Cooperative. Breeding bird point counts. Version 1. `bird-point-counts`.

## Creators

- Invented Research Cooperative

## Rights

- Licensed CC-BY-4.0 (Creative Commons Attribution 4.0 International): <https://creativecommons.org/licenses/by/4.0/>

## About

- **Access:** public
- **Keywords:** birds, point counts, breeding season, forest
- **Temporal coverage:** 2024-06-04 to 2024-06-06
- **Spatial coverage:** west -72.76, south 44.24, east -72.72, north 44.28. Five points 250 m apart in one invented forest block.

## Resources

### `counts`: Point counts

Kind: table. File: `data/counts.csv`.

One row per species at a point on a morning.

| Column       | Title        | Type    | Description                                                                      | Codes | Unit          | Scale    |
| ------------ | ------------ | ------- | -------------------------------------------------------------------------------- | ----- | ------------- | -------- |
| `point`      | Point        | string  | Point code, B1 to B5.                                                            |       |               | nominal  |
| `date`       | Count date   | date    | The morning of the count.                                                        |       |               | dateTime |
| `start_time` | Start time   | time    | Local standard time the ten minutes began.                                       |       |               | dateTime |
| `species`    | Species      | string  | The species' English common name.                                                |       |               | nominal  |
| `count`      | Count        | integer | Birds of the species heard or seen in the ten minutes.                           |       | dimensionless | ratio    |
| `distance_m` | Distance (m) | integer | Estimated distance from the point to the nearest bird of the species, in metres. |       | m             | ratio    |
