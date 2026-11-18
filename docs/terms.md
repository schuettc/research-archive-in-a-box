# Terms

The archive exports each published dataset's metadata as EML (Ecological Metadata Language), so other catalogs can read it. EML has no standard way to say that one column describes another, so the export uses a term of its own, defined here. Its address is this page: `https://github.com/schuettc/research-archive-in-a-box/blob/main/docs/terms.md#ancillaryof`.

## ancillaryOf

A column is **ancillary of** another when its values qualify that column's rather than measuring something themselves. For example, in a table of water temperatures, a `water_temp_unc_c` column holds how far each temperature may be off: it is ancillary of `water_temp_c`, in the role of its uncertainty.

In a package's `datapackage.json`, the ancillary column says so with `archive:ancillaryOf`, naming the other column and the role:

```json
{ "name": "water_temp_unc_c", "type": "number", "archive:ancillaryOf": { "field": "water_temp_c", "role": "uncertainty" } }
```

The role is one of:

- `uncertainty`: how far each value of the other column may be off.
- `detection-limit`: the lowest value the instrument could detect for each reading.
- `quality-flag`: a code saying how far each value can be trusted.

In EML, the ancillary column carries an annotation whose property is this term (`propertyURI` is the address above, labelled `ancillaryOf`) and whose value is the address followed by `/` and the role, such as `…#ancillaryof/uncertainty`, labelled `<role>:<column>`, such as `uncertainty:water_temp_c`. Reading an EML document back, the archive's importer recognises the annotation by that property address.
