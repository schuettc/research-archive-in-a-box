import json
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from archive_contract.config import (
    DISK_MARGIN_MB,
    LAMBDA_DISK_MB,
    MAX_PACKAGE_GIB,
    ArchiveConfig,
    Infrastructure,
    Stage,
    load_config,
)

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_config_reads_from_yaml(tmp_path: Path) -> None:
    path = tmp_path / "archive.yaml"
    path.write_text(
        "publisher: Invented Research Cooperative\n"
        "profiles: [core, ecology]\n"
        "required: [keywords]\n"
        "themes: [water]\n"
        "licenses: [CC-BY-4.0, CC0-1.0]\n"
        "access: [public, restricted]\n"
        "vocabularies:\n"
        "  - field: keywords\n"
        "    name: Invented terms\n"
        "    terms: [temperature, streams]\n",
        encoding="utf-8",
    )

    config = load_config(path)

    assert config.publisher == "Invented Research Cooperative"
    assert [p.name for p in config.load_profiles()] == ["core", "ecology"]
    assert config.access == ["public", "restricted"]
    assert config.vocabularies[0].terms == ["temperature", "streams"]


def test_config_defaults_to_core_and_every_access_level() -> None:
    config = ArchiveConfig(publisher="P")

    assert config.profiles == ["core"]
    assert config.access == ["public", "limited", "restricted", "description-only"]


def test_config_needs_a_publisher() -> None:
    with pytest.raises(ValidationError):
        ArchiveConfig.model_validate({})


def test_config_refuses_unknown_access_levels_and_fields() -> None:
    with pytest.raises(ValidationError):
        ArchiveConfig.model_validate({"publisher": "P", "access": ["unpublished"]})
    with pytest.raises(ValidationError, match="unknown field"):
        ArchiveConfig.model_validate({"publisher": "P", "required": ["colour"]})


def test_config_naming_an_unknown_profile_fails_when_loading_profiles() -> None:
    config = ArchiveConfig.model_validate({"publisher": "P", "profiles": ["astronomy"]})

    with pytest.raises(ValueError, match="no profile named"):
        config.load_profiles()


def test_infrastructure_reads_from_yaml(tmp_path: Path) -> None:
    path = tmp_path / "archive.yaml"
    path.write_text(
        "publisher: P\n"
        "infrastructure:\n"
        "  alertEmail: data@example.edu\n"
        "  monthlyBudgetUsd: 80\n"
        "  stages:\n"
        "    - name: prod\n"
        "      account: '123456789012'\n"
        "      region: us-east-2\n"
        "    - name: dev\n"
        "  modules:\n"
        "    waf: true\n"
        "    objectLock: {retentionDays: 3650}\n",
        encoding="utf-8",
    )

    infrastructure = load_config(path).infrastructure

    assert infrastructure is not None
    assert infrastructure.alert_email == "data@example.edu"
    assert infrastructure.monthly_budget_usd == 80
    assert [s.name for s in infrastructure.stages] == ["prod", "dev"]
    assert infrastructure.stages[0].account == "123456789012"
    assert infrastructure.stages[0].region == "us-east-2"
    assert infrastructure.stages[1].account is None
    assert infrastructure.modules.waf is True
    assert infrastructure.modules.object_lock is not None
    assert infrastructure.modules.object_lock.retention_days == 3650


def test_infrastructure_defaults_to_prod_only() -> None:
    infrastructure = Infrastructure.model_validate({"alertEmail": "a@b.c"})

    assert [s.name for s in infrastructure.stages] == ["prod"]
    assert infrastructure.monthly_budget_usd == 50
    assert infrastructure.modules.waf is False
    assert infrastructure.modules.object_lock is None
    assert infrastructure.modules.embeddings is None


def test_embeddings_present_means_on_with_titan_v2() -> None:
    modules = Infrastructure.model_validate(
        {"alertEmail": "a@b.c", "modules": {"embeddings": {}}}
    ).modules

    assert modules.embeddings is not None
    assert modules.embeddings.model == "amazon.titan-embed-text-v2:0"
    with pytest.raises(ValidationError):
        Infrastructure.model_validate(
            {"alertEmail": "a@b.c", "modules": {"embeddings": {"model": "cohere.embed-v4"}}}
        )
    with pytest.raises(ValidationError):
        Infrastructure.model_validate(
            {"alertEmail": "a@b.c", "modules": {"embeddings": {"dimensions": 512}}}
        )


def test_infrastructure_refuses_unknown_keys() -> None:
    with pytest.raises(ValidationError):
        Infrastructure.model_validate({"alertEmail": "a@b.c", "modules": {"wafs": True}})


def test_infrastructure_refuses_duplicate_stage_names() -> None:
    with pytest.raises(ValidationError, match="unique"):
        Infrastructure.model_validate(
            {"alertEmail": "a@b.c", "stages": [{"name": "prod"}, {"name": "prod"}]}
        )
    with pytest.raises(ValidationError):
        Infrastructure.model_validate({"alertEmail": "a@b.c", "stages": []})


def test_a_stage_keeps_its_data_unless_it_says_otherwise() -> None:
    assert Stage(name="dev").keep_data is True
    assert Stage.model_validate({"name": "prod", "keepData": False}).keep_data is False
    assert Infrastructure.model_validate({"alertEmail": "a@b.c"}).stages[0].keep_data is True
    with pytest.raises(ValidationError):
        Stage.model_validate({"name": "dev", "keepdata": False})


def test_stage_refuses_bad_names_and_accounts() -> None:
    with pytest.raises(ValidationError):
        Stage(name="Prod")
    with pytest.raises(ValidationError):
        Stage(name="prod", account="123")


_DOMAIN = {"name": "data.example.org", "hostedZoneId": "Z0123456789ABCDEF"}


def test_a_stage_with_a_domain_and_region_validates_and_keeps_the_zone_id() -> None:
    stage = Stage.model_validate({"name": "prod", "region": "eu-west-1", "domain": _DOMAIN})

    assert stage.domain is not None
    assert (stage.domain.name, stage.domain.hosted_zone_id) == (
        "data.example.org",
        "Z0123456789ABCDEF",
    )
    assert stage.dump()["domain"] == _DOMAIN


def test_a_stage_with_a_domain_needs_a_region() -> None:
    with pytest.raises(
        ValidationError,
        match="stage prod has a domain, so it needs a region: the certificate is made in "
        "us-east-1 and referenced from the stage's region",
    ):
        Stage.model_validate({"name": "prod", "domain": _DOMAIN})


@pytest.mark.parametrize(
    "domain",
    [
        {"name": "Data.example.org", "hostedZoneId": "Z0123456789ABCDEF"},
        {"name": "data.example.org.", "hostedZoneId": "Z0123456789ABCDEF"},
        {"name": "*.example.org", "hostedZoneId": "Z0123456789ABCDEF"},
        {"name": "localhost", "hostedZoneId": "Z0123456789ABCDEF"},
        {"name": "data.example.org", "hostedZoneId": "/hostedzone/Z0123456789ABCDEF"},
        {"name": "data.example.org", "hostedZoneId": "Z0123456789ABCDEF", "email": "ses"},
    ],
)
def test_a_bad_domain_is_refused(domain: dict[str, str]) -> None:
    with pytest.raises(ValidationError):
        Stage.model_validate({"name": "prod", "region": "us-east-1", "domain": domain})


def test_a_stage_with_no_domain_has_none() -> None:
    assert Stage(name="prod", region="us-east-1").domain is None


def test_a_stage_with_a_domain_can_send_email_through_ses() -> None:
    stage = Stage.model_validate(
        {"name": "prod", "region": "us-east-1", "domain": _DOMAIN, "email": "ses"}
    )

    assert stage.email == "ses"
    assert stage.dump()["email"] == "ses"


def test_email_through_ses_needs_a_domain() -> None:
    with pytest.raises(
        ValidationError,
        match="stage prod sends email through SES from its domain, so it needs a domain",
    ):
        Stage.model_validate({"name": "prod", "region": "us-east-1", "email": "ses"})


def test_email_through_ses_is_refused_in_a_region_without_ses() -> None:
    with pytest.raises(
        ValidationError,
        match="stage prod is in eu-central-2, where Cognito can't send through SES in its own "
        "Region; email: ses isn't supported there yet",
    ):
        Stage.model_validate(
            {"name": "prod", "region": "eu-central-2", "domain": _DOMAIN, "email": "ses"}
        )


@pytest.mark.parametrize("email", ["smtp", True])
def test_an_unknown_email_setting_is_refused(email: object) -> None:
    with pytest.raises(ValidationError):
        Stage.model_validate(
            {"name": "prod", "region": "us-east-1", "domain": _DOMAIN, "email": email}
        )


def test_a_stage_with_no_email_has_none() -> None:
    assert Stage(name="prod", region="us-east-1", domain=_DOMAIN).email is None


@pytest.mark.parametrize(
    "stage",
    [
        {"name": "snap", "region": "us-east-1"},
        {"name": "snapagnostic"},
        {"name": "snapdomain", "region": "us-east-1", "domain": _DOMAIN},
    ],
)
def test_stages_without_email_validate_unchanged(stage: dict[str, object]) -> None:
    assert Stage.model_validate(stage).dump() == {**stage, "keepData": True}


def test_root_archive_yaml_is_valid() -> None:
    config = load_config(REPO_ROOT / "archive.yaml")

    assert config.infrastructure is not None


LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10"/></svg>'


def _brand_config(tmp_path: Path, brand: str) -> Path:
    (tmp_path / "logo.svg").write_text(LOGO, encoding="utf-8")
    (tmp_path / "favicon.svg").write_text(LOGO, encoding="utf-8")
    path = tmp_path / "archive.yaml"
    path.write_text(f"publisher: Invented Research Cooperative\nbrand:\n{brand}", encoding="utf-8")
    return path


VALID_BRAND = (
    "  intro: The cooperative shares the data behind its field studies.\n"
    "  contact: data@example.org\n"
    "  logo: logo.svg\n"
    "  favicon: favicon.svg\n"
    "  primaryColor: '#24395f'\n"
    "  font: Georgia, 'Times New Roman', serif\n"
)


def test_a_valid_brand_block_loads(tmp_path: Path) -> None:
    brand = load_config(_brand_config(tmp_path, VALID_BRAND)).brand

    assert brand is not None
    assert brand.name == "Invented Research Cooperative"
    assert brand.contact == "data@example.org"
    assert brand.logo == "logo.svg"
    assert brand.favicon == "favicon.svg"
    assert brand.primary_color == "#24395f"
    assert brand.font == "Georgia, 'Times New Roman', serif"


def test_a_brand_name_overrides_the_publisher(tmp_path: Path) -> None:
    brand = load_config(_brand_config(tmp_path, "  name: The Archive\n" + VALID_BRAND)).brand

    assert brand is not None
    assert brand.name == "The Archive"


def test_no_brand_block_gives_the_defaults() -> None:
    config = ArchiveConfig(publisher="P")

    assert config.brand is None


@pytest.mark.parametrize(
    ("change", "field"),
    [
        (("primaryColor: '#24395f'", "primaryColor: navy"), "primaryColor"),
        (("logo: logo.svg", "logo: missing.svg"), "logo"),
        (("contact: data@example.org", "contact: not-an-address"), "contact"),
        (("font: Georgia, 'Times New Roman', serif", 'font: "serif; } body { color: red"'), "font"),
        (("logo: logo.svg", "logo: favicon.ico"), "logo"),
    ],
)
def test_a_bad_brand_value_is_refused_naming_its_field(
    tmp_path: Path, change: tuple[str, str], field: str
) -> None:
    path = _brand_config(tmp_path, VALID_BRAND.replace(*change))
    (tmp_path / "favicon.ico").write_bytes(b"\0")

    with pytest.raises(ValidationError, match=rf"brand\.{field}"):
        load_config(path)


def test_a_300_kb_logo_is_refused(tmp_path: Path) -> None:
    path = _brand_config(tmp_path, VALID_BRAND)
    (tmp_path / "logo.svg").write_bytes(b" " * 300 * 1024)

    with pytest.raises(ValidationError, match=r"brand\.logo[\s\S]*200 KB"):
        load_config(path)


def test_an_unknown_brand_key_is_refused(tmp_path: Path) -> None:
    path = _brand_config(tmp_path, VALID_BRAND + "  colour: '#000000'\n")

    with pytest.raises(ValidationError, match=r"brand\.colour"):
        load_config(path)


def test_an_intro_over_600_characters_is_refused(tmp_path: Path) -> None:
    long = VALID_BRAND.replace("field studies.", "x" * 600)

    with pytest.raises(ValidationError, match=r"brand\.intro"):
        load_config(_brand_config(tmp_path, long))


def test_a_privacy_text_loads_as_plain_text(tmp_path: Path) -> None:
    privacy = "  privacy: |-\n    We keep your email.\n\n    Write to us to delete it.\n"
    brand = load_config(_brand_config(tmp_path, VALID_BRAND + privacy)).brand

    assert brand is not None
    assert brand.privacy == "We keep your email.\n\nWrite to us to delete it."


def test_a_privacy_text_over_2500_characters_is_refused(tmp_path: Path) -> None:
    path = _brand_config(tmp_path, VALID_BRAND + f"  privacy: {'x' * 2501}\n")

    with pytest.raises(ValidationError, match=r"brand\.privacy"):
        load_config(path)


def test_root_archive_yaml_has_a_brand_and_fits_the_ssm_parameter() -> None:
    config = load_config(REPO_ROOT / "archive.yaml")
    as_json = json.dumps(yaml.safe_load((REPO_ROOT / "archive.yaml").read_text("utf-8")))

    assert config.brand is not None
    assert config.brand.logo is not None
    assert len(as_json.encode("utf-8")) <= 4096


@pytest.mark.parametrize(
    "svg",
    [
        '<svg xmlns="http://www.w3.org/2000/svg" role="img"><rect width="1" height="1"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" aria-label="X"><rect width="1" height="1"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="x()" width="1" height="1"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
    ],
)
def test_an_svg_cognito_or_a_browser_would_refuse_is_refused(tmp_path: Path, svg: str) -> None:
    # Cognito's managed login refused role and aria-label on a deploy; script, handlers and
    # foreignObject would run in the app, which serves the logo from its own origin.
    path = _brand_config(tmp_path, VALID_BRAND)
    (tmp_path / "logo.svg").write_text(svg, encoding="utf-8")

    with pytest.raises(ValidationError, match=r"brand\.logo[\s\S]*not allowed"):
        load_config(path)


def test_the_spec_doi_block_loads(tmp_path: Path) -> None:
    path = tmp_path / "archive.yaml"
    path.write_text(
        'publisher: P\ndoi:\n  repository: EXAMPLE.IRC\n  prefix: "10.5072"\n  test: true\n',
        encoding="utf-8",
    )

    doi = load_config(path).doi

    assert doi is not None
    assert (doi.repository, doi.prefix, doi.test) == ("EXAMPLE.IRC", "10.5072", True)


def test_a_doi_block_defaults_to_the_test_system() -> None:
    config = ArchiveConfig.model_validate(
        {"publisher": "P", "doi": {"repository": "EXAMPLE.IRC", "prefix": "10.5072"}}
    )

    assert config.doi is not None and config.doi.test is True


def test_no_doi_block_leaves_dois_off() -> None:
    assert ArchiveConfig(publisher="P").doi is None


@pytest.mark.parametrize(
    "doi",
    [
        {"repository": "EXAMPLE.IRC", "prefix": "10.5072", "password": "x"},
        {"repository": "EXAMPLE.IRC", "prefix": "11.5072"},
        {"repository": "EXAMPLE.IRC", "prefix": "10.50"},
        {"repository": "EXAMPLE", "prefix": "10.5072"},
        {"repository": "EXAMPLE.IRC/x", "prefix": "10.5072"},
    ],
)
def test_a_bad_doi_block_is_refused(doi: dict[str, str]) -> None:
    with pytest.raises(ValidationError):
        ArchiveConfig.model_validate({"publisher": "P", "doi": doi})


def test_the_doi_fields_carry_descriptions_for_the_deploy_skill() -> None:
    schema = ArchiveConfig.model_json_schema()

    fields = schema["$defs"]["Doi"]["properties"]
    assert set(fields) == {"repository", "prefix", "test"}
    assert all(field.get("description") for field in fields.values())


_DOI = {"repository": "EXAMPLE.IRC", "prefix": "10.5072"}


def test_a_stage_can_set_its_own_doi_test(tmp_path: Path) -> None:
    path = tmp_path / "archive.yaml"
    path.write_text(
        'publisher: P\ndoi:\n  repository: EXAMPLE.IRC\n  prefix: "10.5072"\n'
        "infrastructure:\n  alertEmail: a@example.org\n  stages:\n"
        "    - name: dev\n    - name: prod\n      doi:\n        test: false\n"
        '        repository: LIVE.IRC\n        prefix: "10.12345"\n',
        encoding="utf-8",
    )

    config = load_config(path)

    assert config.infrastructure is not None
    dev, prod = config.infrastructure.stages
    assert dev.doi is None
    assert prod.doi is not None
    assert (prod.doi.test, prod.doi.repository, prod.doi.prefix) == (False, "LIVE.IRC", "10.12345")


def test_a_stage_doi_may_set_test_alone() -> None:
    config = ArchiveConfig.model_validate(
        {
            "publisher": "P",
            "doi": _DOI,
            "infrastructure": {
                "alertEmail": "a@example.org",
                "stages": [{"name": "prod", "doi": {"test": False}}],
            },
        }
    )

    assert config.infrastructure is not None
    stage_doi = config.infrastructure.stages[0].doi
    assert stage_doi is not None
    assert (stage_doi.repository, stage_doi.prefix) == (None, None)


def test_a_stage_doi_without_the_archive_doi_block_is_refused() -> None:
    with pytest.raises(ValidationError, match="stage prod sets doi, so the archive needs"):
        ArchiveConfig.model_validate(
            {
                "publisher": "P",
                "infrastructure": {
                    "alertEmail": "a@example.org",
                    "stages": [{"name": "prod", "doi": {"test": False}}],
                },
            }
        )


@pytest.mark.parametrize(
    "doi",
    [
        {},
        {"test": False, "password": "x"},
        {"test": False, "prefix": "11.5072"},
        {"test": False, "repository": "EXAMPLE"},
    ],
)
def test_a_bad_stage_doi_block_is_refused(doi: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        ArchiveConfig.model_validate(
            {
                "publisher": "P",
                "doi": _DOI,
                "infrastructure": {
                    "alertEmail": "a@example.org",
                    "stages": [{"name": "prod", "doi": doi}],
                },
            }
        )


def test_the_package_limit_defaults_to_the_ceiling() -> None:
    assert ArchiveConfig.model_validate({"publisher": "X"}).submissions.max_package_gib == 9


def test_the_package_limit_is_read_from_the_file() -> None:
    config = ArchiveConfig.model_validate({"publisher": "X", "submissions": {"maxPackageGiB": 2}})

    assert config.submissions.max_package_gib == 2


def test_the_ceiling_is_the_lambda_disk_less_the_margin() -> None:
    assert MAX_PACKAGE_GIB * 1024 + DISK_MARGIN_MB == LAMBDA_DISK_MB == 10_240


@pytest.mark.parametrize("value", [0, 10, 2.5])
def test_a_package_limit_outside_1_to_the_ceiling_is_refused(value: object) -> None:
    with pytest.raises(ValidationError):
        ArchiveConfig.model_validate({"publisher": "X", "submissions": {"maxPackageGiB": value}})


def test_an_unknown_submissions_setting_is_refused() -> None:
    with pytest.raises(ValidationError):
        ArchiveConfig.model_validate({"publisher": "X", "submissions": {"maxFiles": 5}})
