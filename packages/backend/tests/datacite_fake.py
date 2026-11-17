"""A hand-rolled DataCite for the DOI tests: its DOIs by name, every call, and failures on cue."""

import copy
from typing import Any

from archive_backend.doi import DataCiteError


class FakeDataCite:
    def __init__(self) -> None:
        self.dois: dict[str, dict[str, Any]] = {}
        self.calls: list[tuple[str, str, dict[str, Any] | None]] = []
        self._failures = 0
        self._status = 503

    def fail(self, n: int, status: int = 503) -> None:
        """Make the next `n` calls raise DataCiteError with `status`."""
        self._failures, self._status = n, status

    def _call(self, method: str, doi: str, attributes: dict[str, Any] | None) -> None:
        self.calls.append((method, doi, copy.deepcopy(attributes)))
        if self._failures:
            self._failures -= 1
            raise DataCiteError(self._status, "Service Unavailable")

    def get(self, doi: str) -> dict[str, Any] | None:
        self._call("get", doi, None)
        found = self.dois.get(doi)
        return copy.deepcopy(found) if found is not None else None

    def put(self, doi: str, attributes: dict[str, Any]) -> dict[str, Any]:
        self._call("put", doi, attributes)
        stored = {**self.dois.get(doi, {"state": "draft"})}
        stored.update({k: v for k, v in attributes.items() if k != "event"})
        if attributes.get("event") == "publish":
            stored["state"] = "findable"
        self.dois[doi] = stored
        return copy.deepcopy(stored)

    def puts(self) -> list[tuple[str, dict[str, Any]]]:
        """Every put's DOI and attributes, in order."""
        return [
            (doi, attributes or {}) for method, doi, attributes in self.calls if method == "put"
        ]
