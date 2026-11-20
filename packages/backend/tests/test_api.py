import io
import json
from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from archive_backend import access, api, submissions_api
from archive_backend.reindex import catalog_items, dataset_item

SAMPLE = Path(__file__).parents[3] / "examples" / "sample-package" / "datapackage.json"
ARCHIVE = "archive"
DERIVED = "derived"
TABLE_A = "catalog-a"
TABLE_B = "catalog-b"
PARAMETER = "/research-archive/test/catalog-active"
COUNTS = "download-counts"
USAGE = "usage-responses"
PROFILES = "user-profiles"
ACCESS = "access"
DOMAIN = "d123.cloudfront.net"
DOMAIN_PARAMETER = "/research-archive/test/site-domain"
CONFIG_PARAMETER = "/research-archive/test/archive-config"
EMBEDDINGS_ON = json.dumps(
    {"publisher": "P", "infrastructure": {"alertEmail": "a@b.c", "modules": {"embeddings": {}}}}
)
CLAIMS = {"sub": "user-1", "email": "a@example.org"}
ADMIN = CLAIMS | {"cognito:groups": "[admin]"}


def _missing(operation: str) -> ClientError:
    return ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, operation)


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.heads = 0
        self.gets = 0
        self.presigned: list[dict[str, Any]] = []

    def put(self, bucket: str, key: str, body: Any, etag: str = '"1"') -> None:
        self.objects[(bucket, key)] = (json.dumps(body).encode(), etag)

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self.heads += 1
        if (Bucket, Key) not in self.objects:
            raise _missing("HeadObject")
        return {"ETag": self.objects[(Bucket, Key)][1]}

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        self.gets += 1
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "x"}}, "GetObject")
        body, etag = self.objects[(Bucket, Key)]

        class Body:
            def read(self) -> bytes:
                return body

        return {"Body": Body(), "ETag": etag}

    def generate_presigned_url(
        self, operation: str, *, Params: dict[str, str], ExpiresIn: int
    ) -> str:
        self.presigned.append({"operation": operation, "Params": Params, "ExpiresIn": ExpiresIn})
        return f"https://{Params['Bucket']}.s3.example/{Params['Key']}?signed"


def _key(item: dict[str, Any], names: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(item[n]["S"] for n in names)


class FakeDynamoDB:
    KEYS = {
        TABLE_A: ("PK", "SK"),
        TABLE_B: ("PK", "SK"),
        COUNTS: ("datasetId", "month"),
        USAGE: ("datasetId", "entry"),
        PROFILES: ("userId",),
        ACCESS: ("datasetId", "userId"),
    }

    def __init__(self) -> None:
        self.tables: dict[str, dict[tuple[str, ...], dict[str, Any]]] = {
            name: {} for name in self.KEYS
        }
        self.queries: list[dict[str, Any]] = []
        self.vector_searches: list[dict[str, Any]] = []
        self.nearest: list[str] = []

    def search_vectors(self, **kwargs: Any) -> dict[str, Any]:
        """Answers as botocore's SearchVectors does: keys-only items, most similar first."""
        self.vector_searches.append(kwargs)
        return {
            "SearchResults": [
                {"Item": {"PK": {"S": f"DATASET#{d}"}, "SK": {"S": "META"}}, "Score": 0.1 * n}
                for n, d in enumerate(self.nearest)
            ]
        }

    def load(self, table: str, items: list[dict[str, Any]]) -> None:
        for item in items:
            self.tables[table][_key(item, self.KEYS[table])] = item

    def get_item(self, *, TableName: str, Key: dict[str, Any], **_: Any) -> dict[str, Any]:
        item = self.tables[TableName].get(_key(Key, self.KEYS[TableName]))
        return {"Item": item} if item else {}

    def put_item(self, *, TableName: str, Item: dict[str, Any]) -> dict[str, Any]:
        self.load(TableName, [Item])
        return {}

    def update_item(self, **kwargs: Any) -> dict[str, Any]:
        table, key = kwargs["TableName"], kwargs["Key"]
        assert kwargs["UpdateExpression"] == "ADD #n :one"
        name = kwargs["ExpressionAttributeNames"]["#n"]
        item = self.tables[table].setdefault(_key(key, self.KEYS[table]), dict(key))
        item[name] = {"N": str(int(item.get(name, {"N": "0"})["N"]) + 1)}
        return {}

    def scan(self, **kwargs: Any) -> dict[str, Any]:
        """Every item, two per page."""
        rows = [i for _, i in sorted(self.tables[kwargs["TableName"]].items())]
        start = kwargs.get("ExclusiveStartKey", {}).get("n", 0)
        page: dict[str, Any] = {"Items": rows[start : start + 2]}
        if start + 2 < len(rows):
            page["LastEvaluatedKey"] = {"n": start + 2}
        return page

    def query(self, **kwargs: Any) -> dict[str, Any]:
        """Equality on the partition key, optional begins_with on the sort key, two per page."""
        self.queries.append(kwargs)
        values = kwargs["ExpressionAttributeValues"]
        names = kwargs.get("ExpressionAttributeNames", {})
        table = kwargs["TableName"]
        if kwargs.get("IndexName") == "GSI1":
            pk, sk = "GSI1PK", "GSI1SK"
        else:
            pk, sk = self.KEYS[table]
        rows = [
            i
            for _, i in sorted(self.tables[table].items())
            if i.get(pk) == values[":pk"]
            and (":sk" not in values or i.get(sk, {}).get("S", "").startswith(values[":sk"]["S"]))
        ]
        if "FilterExpression" in kwargs:
            assert kwargs["FilterExpression"] == "attribute_exists(#v)"
            rows = [r for r in rows if names["#v"] in r]
        if kwargs.get("ScanIndexForward") is False:
            rows.reverse()
        start = kwargs.get("ExclusiveStartKey", {}).get("n", 0)
        page: dict[str, Any] = {"Items": rows[start : start + 2]}
        if start + 2 < len(rows):
            page["LastEvaluatedKey"] = {"n": start + 2}
        return page


class FakeSSM:
    def __init__(self) -> None:
        self.value = "B"
        self.calls = 0
        self.config = json.dumps({"publisher": "P"})
        self.config_calls = 0
        self.domain = DOMAIN

    def get_parameter(self, *, Name: str) -> dict[str, Any]:
        if Name == DOMAIN_PARAMETER:
            return {"Parameter": {"Value": self.domain}}
        if Name == CONFIG_PARAMETER:
            self.config_calls += 1
            return {"Parameter": {"Value": self.config}}
        assert Name == PARAMETER
        self.calls += 1
        return {"Parameter": {"Value": self.value}}


class FakeBedrock:
    def __init__(self) -> None:
        self.texts: list[str] = []
        self.error: Exception | None = None

    def invoke_model(self, **kwargs: Any) -> dict[str, Any]:
        if self.error:
            raise self.error
        body = json.loads(kwargs["body"])
        self.texts.append(body["inputText"])
        return {"body": io.BytesIO(json.dumps({"embedding": [0.25] * 1024}).encode())}


class FakeCognito:
    """The pool's accounts by sub, with their live groups, for the live role check."""

    def __init__(self, groups: dict[str, set[str]]) -> None:
        self.groups = groups

    def list_users(self, *, UserPoolId: str, Filter: str, Limit: int) -> dict[str, Any]:
        assert UserPoolId == "pool"
        sub = Filter.split('"')[1]
        if sub not in self.groups:
            return {"Users": []}
        return {
            "Users": [{"Username": f"name-{sub}", "Attributes": [{"Name": "sub", "Value": sub}]}]
        }

    def admin_list_groups_for_user(self, *, UserPoolId: str, Username: str) -> dict[str, Any]:
        assert UserPoolId == "pool"
        names = sorted(self.groups[Username.removeprefix("name-")])
        return {"Groups": [{"GroupName": name} for name in names]}


class World:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.s3 = FakeS3()
        self.dynamodb = FakeDynamoDB()
        self.ssm = FakeSSM()
        self.bedrock = FakeBedrock()
        self.cognito = FakeCognito({"user-1": {"admin"}, "admin-9": {"admin"}})
        self.now = 1000.0
        clients = api.Clients(
            s3=self.s3,  # type: ignore[arg-type]
            dynamodb=self.dynamodb,  # type: ignore[arg-type]
            ssm=self.ssm,  # type: ignore[arg-type]
            bedrock=self.bedrock,
            cognito=self.cognito,  # type: ignore[arg-type]
        )
        monkeypatch.setattr(api, "clients", lambda: clients)
        monkeypatch.setattr(api, "_monotonic", lambda: self.now)
        api.reset_caches()
        for name, value in {
            "ARCHIVE_BUCKET": ARCHIVE,
            "DERIVED_BUCKET": DERIVED,
            "CATALOG_TABLE_A": TABLE_A,
            "CATALOG_TABLE_B": TABLE_B,
            "ACTIVE_CATALOG_PARAMETER": PARAMETER,
            "DOWNLOAD_COUNTS_TABLE": COUNTS,
            "USAGE_TABLE": USAGE,
            "USER_PROFILES_TABLE": PROFILES,
            "ACCESS_TABLE": ACCESS,
            "SITE_DOMAIN_PARAMETER": DOMAIN_PARAMETER,
            "STAGE": "test",
            "ARCHIVE_CONFIG_PARAMETER": CONFIG_PARAMETER,
            "USER_POOL_ID": "pool",
        }.items():
            monkeypatch.setenv(name, value)

    def publish(
        self, dataset_id: str, manifest: dict[str, Any], versions: int = 1, table: str = TABLE_B
    ) -> None:
        access = manifest.get("archive:access", "public")
        prefix = "restricted" if access != "public" else "open"
        items: list[dict[str, Any]] = []
        for version in range(1, versions + 1):
            items += catalog_items(prefix, dataset_id, version, json.dumps(manifest))
        items.append(dataset_item(dataset_id, [(prefix, versions, manifest)]))
        self.dynamodb.load(table, items)

    def call(
        self,
        method: str,
        path: str,
        query: dict[str, list[str]] | None = None,
        body: Any = None,
        claims: dict[str, str] | None = None,
    ) -> tuple[int, Any]:
        event: dict[str, Any] = {
            "resource": path,
            "path": path,
            "httpMethod": method,
            "headers": {"content-type": "application/json"},
            "multiValueHeaders": {},
            "queryStringParameters": {k: v[-1] for k, v in query.items()} if query else None,
            "multiValueQueryStringParameters": query,
            "pathParameters": None,
            "body": json.dumps(body) if body is not None else None,
            "isBase64Encoded": False,
            "requestContext": {"stage": "prod", "path": path},
        }
        if claims is not None:
            event["requestContext"]["authorizer"] = {"claims": claims}
        response = api.handler(event, None)
        text = response.get("body")
        return int(response["statusCode"]), json.loads(text) if text else None


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> Iterator[World]:
    yield World(monkeypatch)
    api.reset_caches()


def _sample(**extra: Any) -> dict[str, Any]:
    return dict(json.loads(SAMPLE.read_text()), **extra)


ROWS = [
    {
        "id": "lake",
        "version": 1,
        "title": "Lake chemistry",
        "access": "public",
        "formats": ["csv"],
        "published": "2026-01-01T00:00:00Z",
    },
    {
        "id": "stream",
        "version": 2,
        "title": "Stream temperature",
        "description": "Hourly lake inflow loggers",
        "access": "limited",
        "formats": ["csv", "shp"],
        "bbox": [177.0, -19.0, -179.0, -16.0],
    },
]


def test_search_filters_pages_and_counts(world: World) -> None:
    world.s3.put(DERIVED, "site/catalog.json", ROWS)

    status, body = world.call("GET", "/api/search", {"q": ["lake"], "access": ["limited"]})

    assert status == 200
    assert body["total"] == 1
    assert body["rows"] == [ROWS[1]]
    assert body["facets"]["access"] == {"public": 1, "limited": 1}
    assert body["facets"]["format"] == {"csv": 1, "shp": 1}


def test_search_reads_from_to_bbox_and_paging(world: World) -> None:
    world.s3.put(DERIVED, "site/catalog.json", ROWS)

    _, boxed = world.call("GET", "/api/search", {"bbox": ["178,-20,-178,-15"]})
    _, dated = world.call("GET", "/api/search", {"from": ["2020-01-01"], "to": ["2021-01-01"]})
    _, paged = world.call("GET", "/api/search", {"page": ["2"], "size": ["1"]})

    assert [r["id"] for r in boxed["rows"]] == ["stream"]
    assert dated["total"] == 0
    assert [r["id"] for r in paged["rows"]] == ["stream"]


@pytest.mark.parametrize(
    "query",
    [
        {"size": ["0"]},
        {"size": ["101"]},
        {"page": ["0"]},
        {"bbox": ["1,2,3"]},
        {"bbox": ["a,b,c,d"]},
    ],
)
def test_search_refuses_bad_paging_and_boxes(world: World, query: dict[str, list[str]]) -> None:
    world.s3.put(DERIVED, "site/catalog.json", ROWS)

    status, _ = world.call("GET", "/api/search", query)

    assert status in (400, 422)


def test_search_rereads_the_catalog_only_when_its_etag_changes(world: World) -> None:
    world.s3.put(DERIVED, "site/catalog.json", ROWS[:1])
    world.call("GET", "/api/search")
    world.s3.put(DERIVED, "site/catalog.json", ROWS, etag='"2"')

    world.now += 30
    _, cached = world.call("GET", "/api/search")
    world.now += 31
    _, fresh = world.call("GET", "/api/search")
    world.now += 61
    world.call("GET", "/api/search")

    assert cached["total"] == 1
    assert fresh["total"] == 2
    assert world.s3.heads == 3
    assert world.s3.gets == 2


def test_search_without_a_catalog_file_finds_nothing(world: World) -> None:
    status, body = world.call("GET", "/api/search")

    assert status == 200
    assert body["total"] == 0 and body["rows"] == []


SEMANTIC_ROWS = [
    *ROWS,
    {"id": "aerosol", "version": 1, "title": "IMPROVE aerosol", "access": "public"},
]


def test_semantic_search_merges_the_nearest_datasets(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(api, "embeddings_enabled", lambda: True)
    world.s3.put(DERIVED, "site/catalog.json", SEMANTIC_ROWS)
    world.dynamodb.nearest = ["aerosol", "stream"]

    _, body = world.call("GET", "/api/search", {"q": ["air pollution"]})
    _, filtered = world.call("GET", "/api/search", {"q": ["lake"], "access": ["limited"]})

    assert [r["id"] for r in body["rows"]] == ["aerosol", "stream"]
    assert body["total"] == 2
    assert world.bedrock.texts == ["air pollution", "lake"]
    [first, _] = world.dynamodb.vector_searches
    assert first["TableName"] == TABLE_B
    assert first["IndexName"] == "datasets"
    assert first["TopK"] == 50
    assert first["SearchVector"] == [{"N": "0.25"}] * 1024
    assert [r["id"] for r in filtered["rows"]] == ["stream"]


def test_semantic_search_needs_a_q(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(api, "embeddings_enabled", lambda: True)
    world.s3.put(DERIVED, "site/catalog.json", SEMANTIC_ROWS)

    _, body = world.call("GET", "/api/search", {"q": [" "]})

    assert body["total"] == 3
    assert world.bedrock.texts == []


def test_semantic_errors_answer_the_keyword_ranking_and_count_a_fallback(
    world: World, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(api, "embeddings_enabled", lambda: True)
    world.s3.put(DERIVED, "site/catalog.json", SEMANTIC_ROWS)
    world.bedrock.error = ClientError(
        {"Error": {"Code": "ThrottlingException", "Message": "slow"}}, "InvokeModel"
    )

    status, body = world.call("GET", "/api/search", {"q": ["lake"]})

    assert status == 200
    assert [r["id"] for r in body["rows"]] == ["lake", "stream"]
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    [metric] = [line for line in lines if "_aws" in line]
    assert metric["SemanticFallback"] == 1
    assert metric["Stage"] == "test"
    [directive] = metric["_aws"]["CloudWatchMetrics"]
    assert directive == {
        "Namespace": "ResearchArchive",
        "Dimensions": [["Stage"]],
        "Metrics": [{"Name": "SemanticFallback", "Unit": "Count"}],
    }
    assert isinstance(metric["_aws"]["Timestamp"], int)


def test_a_failed_config_read_answers_keyword_results_and_counts_a_fallback(
    world: World, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def broken() -> bool:
        raise ClientError({"Error": {"Code": "ParameterNotFound", "Message": "x"}}, "GetParameter")

    monkeypatch.setattr(api, "embeddings_enabled", broken)
    world.s3.put(DERIVED, "site/catalog.json", SEMANTIC_ROWS)

    status, body = world.call("GET", "/api/search", {"q": ["lake"]})

    assert status == 200
    assert [r["id"] for r in body["rows"]] == ["lake", "stream"]
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [line["SemanticFallback"] for line in lines if "_aws" in line] == [1]
    assert world.bedrock.texts == []


def test_the_setting_is_read_from_the_archive_config_once_a_minute(world: World) -> None:
    world.ssm.config = EMBEDDINGS_ON
    world.s3.put(DERIVED, "site/catalog.json", SEMANTIC_ROWS)
    world.dynamodb.nearest = ["aerosol"]

    _, body = world.call("GET", "/api/search", {"q": ["air pollution"]})
    world.now += 30
    world.call("GET", "/api/search", {"q": ["air pollution"]})
    assert world.ssm.config_calls == 1
    world.now += 31
    world.call("GET", "/api/search", {"q": ["air pollution"]})

    assert [r["id"] for r in body["rows"]] == ["aerosol"]
    assert world.ssm.config_calls == 2


def test_a_config_without_infrastructure_leaves_semantic_search_off(world: World) -> None:
    world.s3.put(DERIVED, "site/catalog.json", SEMANTIC_ROWS)

    world.call("GET", "/api/search", {"q": ["lake"]})

    assert world.ssm.config_calls == 1
    assert world.bedrock.texts == []


def test_search_never_embeds_with_the_setting_off(world: World) -> None:
    world.s3.put(DERIVED, "site/catalog.json", SEMANTIC_ROWS)

    _, body = world.call("GET", "/api/search", {"q": ["lake"]})

    assert [r["id"] for r in body["rows"]] == ["lake", "stream"]
    assert world.bedrock.texts == []
    assert world.dynamodb.vector_searches == []


def test_dataset_reads_the_active_table(world: World) -> None:
    world.publish("stream-temperature-sample", _sample(**{"archive:project": "streams"}))
    world.publish("other", {"title": "Only in A"}, table=TABLE_A)

    status, body = world.call("GET", "/api/datasets/stream-temperature-sample")
    missing, _ = world.call("GET", "/api/datasets/other")

    assert status == 200
    assert body["id"] == "stream-temperature-sample"
    assert body["title"] == "Stream temperature at three invented sites"
    assert body["access"] == "public"
    assert body["currentVersion"] == 1
    assert body["project"] == "streams"
    assert body["manifest"]["id"] == "stream-temperature-sample"
    paths = {f["path"] for f in body["files"]}
    assert "data/logger.csv" in paths and "data/sites/sites.dbf" in paths
    logger = next(f for f in body["files"] if f["path"] == "data/logger.csv")
    assert logger["bytes"] == 3400 and logger["format"] == "csv"
    assert missing == 404


def test_active_table_is_cached_for_a_minute(world: World) -> None:
    world.publish("ds", {"title": "In B"})
    world.publish("ds", {"title": "In A"}, table=TABLE_A)

    _, first = world.call("GET", "/api/datasets/ds")
    world.ssm.value = "A"
    world.now += 30
    _, cached = world.call("GET", "/api/datasets/ds")
    world.now += 31
    _, flipped = world.call("GET", "/api/datasets/ds")

    assert [first["title"], cached["title"], flipped["title"]] == ["In B", "In B", "In A"]
    assert world.ssm.calls == 2


def test_versions_and_one_version(world: World) -> None:
    world.publish("ds", {"title": "T", "archive:published": "2026-11-13T10:00:00Z"}, versions=3)

    status, versions = world.call("GET", "/api/datasets/ds/versions")
    one_status, one = world.call("GET", "/api/datasets/ds/versions/2")

    assert status == 200
    assert versions == {
        "versions": [
            {"version": n, "prefix": "open", "publishedAt": "2026-11-13T10:00:00Z"}
            for n in (1, 2, 3)
        ]
    }
    assert one_status == 200
    assert one["version"] == 2
    assert one["manifest"]["title"] == "T"
    assert [f["path"] for f in one["files"]] == ["_zips/all/package.zip"]


@pytest.mark.parametrize(
    "path",
    [
        "/api/datasets/nope",
        "/api/datasets/nope/versions",
        "/api/datasets/nope/versions/1",
        "/api/datasets/ds/versions/9",
        "/api/projects/nope",
    ],
)
def test_missing_reads_answer_404(world: World, path: str) -> None:
    world.publish("ds", {"title": "T"})

    status, _ = world.call("GET", path)

    assert status == 404


def test_project_reads_its_record_and_its_datasets(world: World) -> None:
    world.s3.put(ARCHIVE, "projects/streams/project.json", {"id": "streams", "title": "Streams"})
    for name in ("a", "b", "c"):
        world.publish(name, {"title": name.upper(), "archive:project": "streams"})
    world.publish("elsewhere", {"title": "E", "archive:project": "lakes"})

    status, body = world.call("GET", "/api/projects/streams")

    assert status == 200
    assert body["project"] == {"id": "streams", "title": "Streams"}
    assert [d["id"] for d in body["datasets"]] == ["a", "b", "c"]
    assert body["datasets"][0] == {"id": "a", "title": "A", "access": "public", "currentVersion": 1}
    assert world.dynamodb.queries[-1]["IndexName"] == "GSI1"


def _download(world: World, dataset: str, path: str, claims: Any = CLAIMS) -> tuple[int, Any]:
    return world.call(
        "GET", f"/api/datasets/{dataset}/versions/1/download", {"path": [path]}, claims=claims
    )


def test_download_of_a_public_file_answers_its_data_url(world: World) -> None:
    world.publish("ds", _sample())

    status, body = _download(world, "ds", "data/logger.csv")

    assert status == 200
    assert body == {"url": f"https://{DOMAIN}/data/ds/1/data/logger.csv"}
    assert world.s3.presigned == []
    assert world.dynamodb.tables[COUNTS] == {}


def test_with_the_stages_domain_a_public_download_answers_on_it(world: World) -> None:
    world.ssm.domain = "data.example.org"
    world.publish("ds", _sample())

    status, body = _download(world, "ds", "data/logger.csv")

    assert status == 200
    assert body == {"url": "https://data.example.org/data/ds/1/data/logger.csv"}


def test_download_of_a_limited_file_signs_it_for_five_minutes_and_counts_it(
    world: World,
) -> None:
    world.publish("ds", _sample(**{"archive:access": "limited"}))

    status, body = _download(world, "ds", "data/sites/sites.dbf")

    assert status == 200
    assert world.s3.presigned == [
        {
            "operation": "get_object",
            "Params": {"Bucket": ARCHIVE, "Key": "restricted/ds/1/data/sites/sites.dbf"},
            "ExpiresIn": 300,
        }
    ]
    assert body == {
        "url": f"https://{ARCHIVE}.s3.example/restricted/ds/1/data/sites/sites.dbf?signed"
    }
    [count] = world.dynamodb.tables[COUNTS].values()
    assert count["datasetId"] == {"S": "ds"}
    assert len(count["month"]["S"]) == 7 and count["month"]["S"][4] == "-"
    assert count["restricted"] == {"N": "1"}


def test_a_limited_zip_is_a_file_the_download_route_signs(world: World) -> None:
    world.publish("ds", _sample(**{"archive:access": "limited"}))

    status, body = _download(world, "ds", "_zips/sites.zip")

    assert status == 200
    assert world.s3.presigned[0]["Params"] == {
        "Bucket": ARCHIVE,
        "Key": "restricted/ds/1/_zips/sites.zip",
    }
    assert _download(world, "ds", "_zips/all/package.zip")[0] == 200


@pytest.mark.parametrize(
    ("access", "path", "claims", "expected"),
    [
        ("limited", "data/../../open/other/1/x.csv", CLAIMS, 404),
        ("limited", "data/nope.csv", CLAIMS, 404),
        ("description-only", "data/logger.csv", CLAIMS, 404),
    ],
)
def test_download_refusals(
    world: World, access: str, path: str, claims: dict[str, str] | None, expected: int
) -> None:
    world.publish("ds", _sample(**{"archive:access": access}))

    status, _ = _download(world, "ds", path, claims)

    assert status == expected
    assert world.s3.presigned == []
    assert world.dynamodb.tables[COUNTS] == {}


def test_download_of_a_public_file_needs_no_sign_in(world: World) -> None:
    world.publish("ds", _sample())

    status, body = _download(world, "ds", "data/logger.csv", None)

    assert status == 200
    assert body == {"url": f"https://{DOMAIN}/data/ds/1/data/logger.csv"}


TODAY = date(2026, 11, 16)


def _disable(world: World, sub: str = "user-1") -> None:
    world.dynamodb.load(PROFILES, [{"userId": {"S": sub}, "disabled": {"BOOL": True}}])


def _access(world: World, state: str, until: str | None = None, sub: str = "user-1") -> None:
    item: dict[str, Any] = {
        "datasetId": {"S": "ds"},
        "userId": {"S": sub},
        "state": {"S": state},
        "reason": {"S": "a thesis"},
        "requestedAt": {"S": "2026-11-01T00:00:00Z"},
    }
    if until is not None:
        item["until"] = {"S": until}
    world.dynamodb.load(ACCESS, [item])


def _refused(world: World, access_level: str, reason: str, claims: Any = CLAIMS) -> None:
    world.publish("ds", _sample(**{"archive:access": access_level}))

    status, body = _download(world, "ds", "data/logger.csv", claims)

    assert (status, body["message"]) == (403, reason)
    assert world.s3.presigned == []
    assert world.dynamodb.tables[COUNTS] == {}


@pytest.fixture
def today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(access, "today", lambda: TODAY)


def test_a_limited_download_needs_a_sign_in(world: World) -> None:
    _refused(world, "limited", "sign in first", claims=None)


def test_a_disabled_account_cant_download_a_limited_file(world: World) -> None:
    _disable(world)
    _refused(world, "limited", "your account is disabled")


def test_a_restricted_download_needs_a_sign_in(world: World) -> None:
    _refused(world, "restricted", "sign in first", claims=None)


def test_a_restricted_download_with_no_request_says_ask_for_access(world: World) -> None:
    _access(world, "approved", sub="someone-else")
    _refused(world, "restricted", "ask for access")


def test_a_restricted_download_with_a_waiting_request_says_so(world: World) -> None:
    _access(world, "waiting")
    _refused(world, "restricted", "your request is waiting")


def test_a_restricted_download_after_a_decline_says_so(world: World) -> None:
    _access(world, "declined")
    _refused(world, "restricted", "your request was declined")


def test_a_restricted_download_after_a_take_back_says_access_ended(world: World) -> None:
    _access(world, "taken-back")
    _refused(world, "restricted", "your access ended")


def test_a_restricted_download_after_the_until_day_says_access_ended(
    world: World, today: None
) -> None:
    _access(world, "approved", until="2026-11-15")
    _refused(world, "restricted", "your access ended")


def test_a_disabled_account_cant_download_even_with_an_approval(world: World) -> None:
    _access(world, "approved")
    _disable(world)
    _refused(world, "restricted", "your account is disabled")


def _approved_download(world: World) -> None:
    world.publish("ds", _sample(**{"archive:access": "restricted"}))

    status, body = _download(world, "ds", "data/logger.csv")

    assert status == 200
    assert world.s3.presigned[0]["Params"] == {
        "Bucket": ARCHIVE,
        "Key": "restricted/ds/1/data/logger.csv",
    }
    assert body["url"].endswith("?signed")
    [count] = world.dynamodb.tables[COUNTS].values()
    assert count["restricted"] == {"N": "1"}


def test_an_approval_without_an_end_signs_and_counts_a_restricted_download(world: World) -> None:
    _access(world, "approved")
    _approved_download(world)


def test_an_approval_lasts_through_its_until_day(world: World, today: None) -> None:
    _access(world, "approved", until="2026-11-16")
    _approved_download(world)


def _publish_versions(world: World, *levels: str) -> None:
    """One version per level, each under its own prefix; the dataset item from the last."""
    items: list[dict[str, Any]] = []
    versions = []
    for number, level in enumerate(levels, start=1):
        manifest = _sample(**{"archive:access": level})
        prefix = "open" if level == "public" else "restricted"
        items += catalog_items(prefix, "ds", number, json.dumps(manifest))
        versions.append((prefix, number, manifest))
    items.append(dataset_item("ds", versions))
    world.dynamodb.load(TABLE_B, items)


def test_an_older_restricted_version_stays_restricted_after_a_limited_one(world: World) -> None:
    _publish_versions(world, "restricted", "limited")

    status, body = _download(world, "ds", "data/logger.csv")

    assert (status, body["message"]) == (403, "ask for access")
    assert world.s3.presigned == []


def test_an_older_public_version_is_signed_under_its_own_prefix(world: World) -> None:
    _publish_versions(world, "public", "limited")

    status, _ = _download(world, "ds", "data/logger.csv")

    assert status == 200
    assert world.s3.presigned[0]["Params"]["Key"] == "open/ds/1/data/logger.csv"


def test_download_of_a_missing_dataset_or_version_answers_404(world: World) -> None:
    world.publish("ds", _sample(**{"archive:access": "limited"}))

    assert _download(world, "nope", "data/logger.csv")[0] == 404
    status, _ = world.call(
        "GET", "/api/datasets/ds/versions/2/download", {"path": ["data/logger.csv"]}, claims=CLAIMS
    )
    assert status == 404


def test_usage_answers_are_stored(world: World) -> None:
    world.publish("ds", {"title": "T"})

    status, body = world.call(
        "POST",
        "/api/datasets/ds/usage",
        body={"organisation": "university", "purpose": "teaching", "note": "Class"},
    )

    assert status == 204 and body is None
    [entry] = world.dynamodb.tables[USAGE].values()
    month, _, uid = entry["entry"]["S"].partition("#")
    assert len(month) == 7 and len(uid) == 36
    assert entry["datasetId"] == {"S": "ds"}
    assert entry["organisation"] == {"S": "university"}
    assert entry["purpose"] == {"S": "teaching"}
    assert entry["note"] == {"S": "Class"}
    assert entry["at"]["S"].startswith(month)


def test_usage_with_no_answers_is_stored_bare(world: World) -> None:
    world.publish("ds", {"title": "T"})

    status, _ = world.call("POST", "/api/datasets/ds/usage", body={})

    assert status == 204
    [entry] = world.dynamodb.tables[USAGE].values()
    assert set(entry) == {"datasetId", "entry", "at"}


def test_usage_for_an_unknown_dataset_or_bad_answer_is_refused(world: World) -> None:
    world.publish("ds", {"title": "T"})

    unknown, _ = world.call("POST", "/api/datasets/nope/usage", body={})
    bad, _ = world.call("POST", "/api/datasets/ds/usage", body={"email": "a@example.org"})

    assert unknown == 404
    assert bad == 422
    assert world.dynamodb.tables[USAGE] == {}


def test_admin_usage_needs_the_admin_group(world: World) -> None:
    world.publish("ds", {"title": "T"})
    for n in range(3):
        world.dynamodb.load(
            USAGE,
            [
                {
                    "datasetId": {"S": "ds"},
                    "entry": {"S": f"2026-1{n}#id-{n}"},
                    "at": {"S": f"2026-1{n}-01T00:00:00Z"},
                    "purpose": {"S": "research"},
                }
            ],
        )

    signed_out, _ = world.call("GET", "/api/admin/usage", {"dataset": ["ds"]})
    not_admin, _ = world.call("GET", "/api/admin/usage", {"dataset": ["ds"]}, claims=CLAIMS)
    status, body = world.call("GET", "/api/admin/usage", {"dataset": ["ds"]}, claims=ADMIN)

    assert signed_out == 401
    assert not_admin == 403
    assert status == 200
    assert [e["entry"] for e in body["entries"]] == ["2026-12#id-2", "2026-11#id-1", "2026-10#id-0"]
    assert body["entries"][0] == {
        "datasetId": "ds",
        "entry": "2026-12#id-2",
        "at": "2026-12-01T00:00:00Z",
        "purpose": "research",
    }


def test_openapi_lists_every_route(tmp_path: Path) -> None:
    out = tmp_path / "openapi.json"

    api.main([str(out)])

    spec = json.loads(out.read_text())
    assert set(spec["paths"]) == {
        "/api/search",
        "/api/datasets/{id}",
        "/api/datasets/{id}/versions",
        "/api/datasets/{id}/versions/{version}",
        "/api/datasets/{id}/versions/{version}/download",
        "/api/datasets/{id}/usage",
        "/api/projects/{id}",
        "/api/admin/usage",
        "/api/admin/downloads",
        "/api/admin/datasets/{id}/withdraw",
        "/api/admin/datasets/{id}/restore",
        "/api/admin/datasets/{id}/embargo",
        "/api/datasets/{id}/versions/{version}/metadata",
        "/api/submissions",
        "/api/submissions/policy",
        "/api/submissions/{id}",
        "/api/submissions/{id}/uploads",
        "/api/submissions/{id}/submit",
        "/api/submissions/{id}/decision",
        "/api/submissions/{id}/files",
        "/api/submissions/{id}/edits",
        "/api/people",
        "/api/curators",
        "/api/checks",
        "/api/admin/people",
        "/api/admin/people/{sub}/roles",
        "/api/admin/people/{sub}/resend",
        "/api/admin/people/{sub}/disable",
        "/api/admin/people/{sub}/enable",
        "/api/admin/account-events",
        "/api/datasets/{id}/access",
        "/api/datasets/{id}/access-requests",
        "/api/admin/access-requests",
        "/api/admin/access-requests/{dataset}/{sub}/decision",
        "/api/admin/access-requests/{dataset}/{sub}/take-back",
    }
    invite = spec["paths"]["/api/admin/people"]["post"]
    assert invite["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/InviteRequest"
    }
    assert "Account" in spec["components"]["schemas"]
    assert out.read_text() == json.dumps(spec, indent=2, sort_keys=True) + "\n"


def test_download_of_an_open_file_encodes_its_path(world: World) -> None:
    world.publish(
        "ds",
        {
            "title": "T",
            "resources": [{"name": "r", "path": "data/results #1?.csv", "format": "csv"}],
        },
    )

    status, body = _download(world, "ds", "data/results #1?.csv")

    assert status == 200
    assert body == {"url": f"https://{DOMAIN}/data/ds/1/data/results%20%231%3F.csv"}


def test_admin_usage_orders_one_month_by_time(world: World) -> None:
    world.publish("ds", {"title": "T"})
    # The later answer has the lower uuid, so the sort key alone would put it second.
    for uid, at in (("zzz", "2026-11-02T00:00:00Z"), ("aaa", "2026-11-20T00:00:00Z")):
        world.dynamodb.load(
            USAGE,
            [{"datasetId": {"S": "ds"}, "entry": {"S": f"2026-11#{uid}"}, "at": {"S": at}}],
        )
    world.dynamodb.load(
        USAGE,
        [
            {
                "datasetId": {"S": "ds"},
                "entry": {"S": "2026-10#mmm"},
                "at": {"S": "2026-10-31T00:00:00Z"},
            }
        ],
    )

    _, body = world.call("GET", "/api/admin/usage", {"dataset": ["ds"]}, claims=ADMIN)

    assert [e["entry"] for e in body["entries"]] == ["2026-11#aaa", "2026-11#zzz", "2026-10#mmm"]


def test_the_submissions_schemas_come_from_their_models(tmp_path: Path) -> None:
    out = tmp_path / "openapi.json"
    api.main([str(out)])
    spec = json.loads(out.read_text())
    schemas = spec["components"]["schemas"]

    assert set(schemas["Submission"]["properties"]) == {
        info.alias or name for name, info in submissions_api.Submission.model_fields.items()
    }
    assert "callbackId" not in schemas["Submission"]["properties"]
    assert schemas["Finding"]["properties"]["severity"]["enum"] == ["error", "warning", "note"]
    read = spec["paths"]["/api/submissions/{id}"]["get"]["responses"]["200"]
    assert read["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/SubmissionRead"
    }
    # The read API's own components are still there, untouched.
    assert "FileEntry" in schemas and "SearchAnswer" in schemas


WITHDRAWN = {"at": "2026-11-20T10:00:00Z", "by": "admin-1", "reason": "Consent ended."}


def _withdraw(world: World, dataset_id: str) -> None:
    meta = world.dynamodb.tables[TABLE_B][(f"DATASET#{dataset_id}", "META")]
    meta["withdrawn"] = {"S": json.dumps(WITHDRAWN)}


def test_a_withdrawn_dataset_answers_its_withdrawal_and_no_files(world: World) -> None:
    world.publish("ds", _sample(), versions=2)
    _withdraw(world, "ds")

    status, body = world.call("GET", "/api/datasets/ds")
    _, version = world.call("GET", "/api/datasets/ds/versions/1")

    assert status == 200
    assert body["withdrawn"] == WITHDRAWN
    assert body["files"] == []
    assert body["title"] == "Stream temperature at three invented sites"
    assert version["files"] == []


def test_a_dataset_that_is_not_withdrawn_has_no_withdrawn_field(world: World) -> None:
    world.publish("ds", _sample())

    _, body = world.call("GET", "/api/datasets/ds")

    assert "withdrawn" not in body
    assert body["files"]


# Task 7: withdrawal and embargo refusals, before the access-level checks.

APPROVED = CLAIMS
STRANGER = None
SIGNED_IN = {"sub": "user-2", "email": "b@example.org"}
# An admin with no approval of their own: being an admin opens no restricted file.
AN_ADMIN = {"sub": "admin-9", "cognito:groups": "[admin]"}
CALLERS = {"stranger": STRANGER, "signed-in": SIGNED_IN, "approved": APPROVED, "admin": AN_ADMIN}
LEVELS = ("public", "limited", "restricted")


def _held(world: World, level: str, until: str | None) -> None:
    extra: dict[str, Any] = {"archive:access": level}
    if until is not None:
        extra["archive:embargoUntil"] = until
    world.publish("ds", _sample(**extra))
    # The person user-1 holds an approval; user-2 has never asked.
    _access(world, "approved")


@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize("caller", CALLERS)
def test_every_file_of_a_withdrawn_dataset_is_refused_for_everyone(
    world: World, level: str, caller: str
) -> None:
    _held(world, level, None)
    _withdraw(world, "ds")

    status, body = _download(world, "ds", "data/logger.csv", CALLERS[caller])

    assert (status, body["message"]) == (403, "This dataset has been withdrawn.")
    assert world.s3.presigned == []
    assert world.dynamodb.tables[COUNTS] == {}


@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize("caller", CALLERS)
def test_an_embargo_still_to_come_refuses_every_file_for_everyone(
    world: World, today: None, level: str, caller: str
) -> None:
    _held(world, level, "2026-11-17")

    status, body = _download(world, "ds", "data/logger.csv", CALLERS[caller])

    assert (status, body["message"]) == (403, "Files are available from 2026-11-17.")
    assert world.s3.presigned == []
    assert world.dynamodb.tables[COUNTS] == {}


# On the date and after it, the level's own rule decides, as with no embargo at all.
EXPECTED = {
    ("public", "stranger"): 200,
    ("public", "signed-in"): 200,
    ("public", "approved"): 200,
    ("public", "admin"): 200,
    ("limited", "stranger"): 403,
    ("limited", "signed-in"): 200,
    ("limited", "approved"): 200,
    ("limited", "admin"): 200,
    ("restricted", "stranger"): 403,
    ("restricted", "signed-in"): 403,
    ("restricted", "approved"): 200,
    ("restricted", "admin"): 403,
}


@pytest.mark.parametrize("until", ["2026-11-16", "2026-11-15"])
@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize("caller", CALLERS)
def test_on_and_after_the_embargo_date_the_access_level_applies(
    world: World, today: None, until: str, level: str, caller: str
) -> None:
    _held(world, level, until)

    status, body = _download(world, "ds", "data/logger.csv", CALLERS[caller])

    assert status == EXPECTED[(level, caller)]
    if status == 403:
        assert "withdrawn" not in body["message"] and "available from" not in body["message"]


def test_an_older_version_is_held_by_the_datasets_embargo(world: World, today: None) -> None:
    world.publish("ds", _sample(), versions=2)
    meta = world.dynamodb.tables[TABLE_B][("DATASET#ds", "META")]
    meta["embargoUntil"] = {"S": "2026-12-01"}

    status, body = _download(world, "ds", "data/logger.csv")

    assert (status, body["message"]) == (403, "Files are available from 2026-12-01.")


def test_the_dataset_answers_its_embargo_date(world: World) -> None:
    world.publish("ds", _sample(**{"archive:embargoUntil": "2026-12-01"}))
    world.publish("free", _sample())

    _, held = world.call("GET", "/api/datasets/ds")
    _, free = world.call("GET", "/api/datasets/free")

    assert held["embargoUntil"] == "2026-12-01"
    assert "embargoUntil" not in free


# Task 9: download totals and the admin downloads route.


def _counts(world: World, dataset_id: str, month: str, open: int = 0, signed: int = 0) -> None:
    item: dict[str, Any] = {"datasetId": {"S": dataset_id}, "month": {"S": month}}
    if open:
        item["open"] = {"N": str(open)}
        item["countedDays"] = {"SS": [f"{month}-01"]}
    if signed:
        item["restricted"] = {"N": str(signed)}
    world.dynamodb.load(COUNTS, [item])


def test_the_dataset_answers_its_total_downloads_over_every_month(world: World) -> None:
    world.publish("ds", _sample())
    _counts(world, "ds", "2026-09", open=5)
    _counts(world, "ds", "2026-10", open=2, signed=3)
    _counts(world, "ds", "2026-11", signed=1)
    _counts(world, "other", "2026-11", open=100)

    _, body = world.call("GET", "/api/datasets/ds")

    assert body["downloads"] == 11


def test_a_dataset_never_downloaded_has_no_total(world: World) -> None:
    world.publish("ds", _sample())

    _, body = world.call("GET", "/api/datasets/ds")

    assert "downloads" not in body


def test_the_total_is_left_out_while_embargoed_or_withdrawn(world: World, today: None) -> None:
    world.publish("held", _sample(**{"archive:embargoUntil": "2026-12-01"}))
    world.publish("gone", _sample())
    _withdraw(world, "gone")
    for dataset_id in ("held", "gone"):
        _counts(world, dataset_id, "2026-11", open=4)

    _, held = world.call("GET", "/api/datasets/held")
    _, gone = world.call("GET", "/api/datasets/gone")

    assert "downloads" not in held and "downloads" not in gone


def _downloads(world: World, months: str, claims: Any = ADMIN) -> tuple[int, Any]:
    return world.call("GET", "/api/admin/downloads", {"months": [months]}, claims=claims)


@pytest.fixture
def november(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(api, "_now", lambda: datetime(2026, 11, 16, tzinfo=UTC))


def test_admin_downloads_lists_each_dataset_by_month_for_the_months_asked(
    world: World, november: None
) -> None:
    world.publish("ds", _sample())
    world.publish("other", {"title": "Other", "archive:access": "limited"})
    _counts(world, "ds", "2025-10", open=7)
    _counts(world, "ds", "2026-09", open=2, signed=1)
    _counts(world, "ds", "2026-11", open=4)
    _counts(world, "other", "2026-10", signed=2)

    status, three = _downloads(world, "3")
    _, year = _downloads(world, "12")
    _, every = _downloads(world, "all")

    assert status == 200
    assert three == {
        "months": ["2026-09", "2026-10", "2026-11"],
        "rows": [
            {
                "id": "ds",
                "title": "Stream temperature at three invented sites",
                "access": "public",
                "counts": {"2026-09": 3, "2026-11": 4},
                "total": 7,
            },
            {
                "id": "other",
                "title": "Other",
                "access": "limited",
                "counts": {"2026-10": 2},
                "total": 2,
            },
        ],
    }
    assert year["months"][0] == "2025-12" and year["months"][-1] == "2026-11"
    assert [row["total"] for row in year["rows"]] == [7, 2]
    assert every["months"][0] == "2025-10"
    assert every["rows"][0]["counts"]["2025-10"] == 7
    assert every["rows"][0]["total"] == 14


def test_admin_downloads_is_for_admins_and_takes_3_12_or_all(world: World, november: None) -> None:
    unsigned, _ = _downloads(world, "3", claims=None)
    user, _ = _downloads(world, "3", claims=CLAIMS)
    bad, _ = _downloads(world, "6")

    assert (unsigned, user, bad) == (401, 403, 422)


def test_admin_downloads_refuses_a_disabled_or_demoted_admin_whose_token_says_admin(
    world: World, november: None
) -> None:
    world.publish("ds", _sample())
    _counts(world, "ds", "2026-11", open=4)
    world.cognito.groups["user-1"] = {"curator"}
    _disable(world, "admin-9")

    demoted, _ = _downloads(world, "3")
    disabled, _ = _downloads(world, "3", AN_ADMIN)

    assert (demoted, disabled) == (403, 403)


def test_admin_usage_refuses_a_disabled_or_demoted_admin_whose_token_says_admin(
    world: World,
) -> None:
    world.cognito.groups["user-1"] = {"curator"}
    _disable(world, "admin-9")

    demoted, _ = world.call("GET", "/api/admin/usage", {"dataset": ["ds"]}, claims=ADMIN)
    disabled, _ = world.call("GET", "/api/admin/usage", {"dataset": ["ds"]}, claims=AN_ADMIN)

    assert (demoted, disabled) == (403, 403)


def test_a_public_file_not_yet_released_from_restricted_is_signed_where_it_is(
    world: World, today: None
) -> None:
    # The embargo ended today, and the lifecycle hasn't moved the files to open/ yet.
    world.publish("ds", _sample(**{"archive:embargoUntil": TODAY.isoformat()}))
    world.dynamodb.tables[TABLE_B][("DATASET#ds", "V#000001")]["prefix"] = {"S": "restricted"}

    status, body = _download(world, "ds", "data/sites/sites.dbf", None)

    assert status == 200
    key = "restricted/ds/1/data/sites/sites.dbf"
    assert body == {"url": f"https://{ARCHIVE}.s3.example/{key}?signed"}
    assert [p["Params"]["Key"] for p in world.s3.presigned] == [key]
    [count] = world.dynamodb.tables[COUNTS].values()
    assert count["restricted"] == {"N": "1"}


def test_a_claim_only_item_is_no_dataset(world: World) -> None:
    # A first version being published: the claim, with no currentVersion yet.
    world.dynamodb.load(
        TABLE_B, [{"PK": {"S": "DATASET#stream"}, "SK": {"S": "META"}, "claimedBy": {"S": "sub-a"}}]
    )

    for path in ("/api/datasets/stream", "/api/datasets/stream/versions"):
        assert world.call("GET", path)[0] == 404
