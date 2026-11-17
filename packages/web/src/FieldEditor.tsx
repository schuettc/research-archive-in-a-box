import { useId, useState, type FormEvent } from "react";
import type { Finding } from "./api";
import { editableKind } from "./package";

/**
 * The box beside one of the three text findings: a description for the two description
 * checks, a unit for the unit check. `current` is what the manifest holds now; `onSave` hears
 * the trimmed text, and a failure's message is shown under the box with the text kept.
 */
export function FieldEditor({
  finding,
  current,
  onSave,
}: {
  finding: Finding;
  current: string;
  onSave: (value: string) => Promise<void>;
}) {
  const id = useId();
  const kind = editableKind(finding);
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!kind) return null;
  const where = `${finding.target?.resource} › ${finding.target?.field}`;
  const label = `${kind === "unit" ? "Unit" : "Description"} of ${where}`;
  const text = value.trim();
  const unchanged = text === current.trim();

  async function save(event: FormEvent) {
    event.preventDefault();
    // Save stays pressable, so it reads as the box's action; with nothing to save it says why.
    if (!text) {
      setProblem(`Type ${kind === "unit" ? "a unit" : "a description"} first.`);
      return;
    }
    if (unchanged) {
      setProblem("Change the text first, or press Cancel.");
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await onSave(text);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "It couldn't be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="field-editor" onSubmit={(event) => void save(event)}>
      <label htmlFor={id}>{label}</label>
      {kind === "unit" ? (
        <input
          id={id}
          type="text"
          value={value}
          placeholder="such as degC, cm or V"
          onChange={(event) => setValue(event.target.value)}
        />
      ) : (
        <textarea
          id={id}
          rows={2}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      <p className="actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setValue(current);
            setProblem(null);
          }}
        >
          Cancel
        </button>
      </p>
      {problem && (
        <p role="alert" className="problem">
          {problem}
        </p>
      )}
    </form>
  );
}
