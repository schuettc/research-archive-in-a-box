# Tree-ring widths from one stand

Annual ring widths for 2014 to 2023 measured on cores from two invented sugar maples in one stand, with the latewood part of each ring. Every tree and width is invented.

This README is generated from `datapackage.json`. Edit the manifest, not this file.

## Citation

Invented Research Cooperative. Tree-ring widths from one stand. Version 1. `tree-rings`.

## Creators

- Invented Research Cooperative

## Rights

- Licensed CC-BY-4.0 (Creative Commons Attribution 4.0 International): <https://creativecommons.org/licenses/by/4.0/>

## About

- **Access:** public
- **Keywords:** tree rings, dendrochronology, sugar maple, growth
- **Temporal coverage:** 2014-01-01 to 2023-12-31
- **Spatial coverage:** west -72.75, south 44.25, east -72.74, north 44.26. One invented hardwood stand.

## Resources

### `rings`: Ring widths

Kind: table. File: `data/rings.csv`.

One row per tree and year.

| Column              | Title               | Type   | Description                                                   | Codes | Unit | Scale    |
| ------------------- | ------------------- | ------ | ------------------------------------------------------------- | ----- | ---- | -------- |
| `tree`              | Tree                | string | Tree code, T01 or T02.                                        |       |      | nominal  |
| `year`              | Year                | year   | The calendar year the ring grew in.                           |       |      | dateTime |
| `ring_width_mm`     | Ring width (mm)     | number | Width of the whole ring along the core, in millimetres.       |       | mm   | ratio    |
| `latewood_width_mm` | Latewood width (mm) | number | Width of the ring's darker, late-season wood, in millimetres. |       | mm   | ratio    |
