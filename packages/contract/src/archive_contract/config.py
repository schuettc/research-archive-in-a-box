"""The archive config: the one file an adopter edits."""

from pathlib import Path
from typing import Literal, Self, get_args
from xml.etree import ElementTree

import yaml
from pydantic import ConfigDict, PositiveInt, ValidationInfo, field_validator, model_validator
from pydantic import Field as PydanticField

from archive_contract._base import ArchiveModel
from archive_contract.manifest import AccessLevel
from archive_contract.profile import Profile, Vocabulary, check_known_fields, load_profile


def _every_access_level() -> list[AccessLevel]:
    return list(get_args(AccessLevel))


class _Strict(ArchiveModel):
    """An infrastructure model: an unknown key is a typo, so it fails validation."""

    model_config = ConfigDict(extra="forbid")


class Domain(_Strict):
    """A stage's own address, in a Route 53 public hosted zone: a certificate for it in
    us-east-1, the name on the distribution and its alias records. Email through SES (`email`)
    is on `Stage`, not in here, and needs this block."""

    name: str = PydanticField(
        max_length=253,
        pattern=r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$",
        description="The site's own address, such as data.example.org, in the hosted zone below.",
    )
    hosted_zone_id: str = PydanticField(
        alias="hostedZoneId",
        pattern=r"^Z[A-Z0-9]{1,31}$",
        description="The id of the Route 53 public hosted zone that holds the name, in the "
        "stage's account: the bare Z... id, not /hostedzone/Z....",
    )


# The Regions Cognito's page marks Alternate Region, where SES isn't available, so a user pool
# can't send through an SES identity in its own Region: "Amazon SES email configuration Regions"
# and its table on https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html.
# Kept in sync with REGIONS_WITHOUT_SES in packages/infra/src/email.ts.
_REGIONS_WITHOUT_SES = {
    "ca-west-1",
    "mx-central-1",
    "ap-east-1",
    "ap-southeast-5",
    "ap-southeast-7",
    "ap-south-2",
    "ap-southeast-4",
    "eu-central-2",
    "eu-south-2",
    "me-central-1",
}


# DataCite's repository id and DOI prefix, shared by the archive's doi block and a stage's.
_DOI_REPOSITORY = r"^[A-Za-z0-9-]+\.[A-Za-z0-9-]+$"
_DOI_PREFIX = r"^10\.[0-9]{4,9}$"


class StageDoi(_Strict):
    """A stage's own DOI settings, each over the archive-wide `doi` block, which it needs. Test
    and live DataCite are separate accounts, so a stage going live names its live repository and
    prefix with `test: false`; its password is already its own, at
    /research-archive/<stage>/datacite-password."""

    test: bool = PydanticField(
        description="This stage's doi.test, over the archive-wide one: false registers live "
        "DOIs from this stage only, such as prod, while the other stages stay on the test system.",
    )
    repository: str | None = PydanticField(
        default=None,
        pattern=_DOI_REPOSITORY,
        description="This stage's DataCite repository id, over the archive-wide one: the live "
        "account's for a stage with test: false.",
    )
    prefix: str | None = PydanticField(
        default=None,
        pattern=_DOI_PREFIX,
        description="This stage's DOI prefix, over the archive-wide one: the live repository's "
        "for a stage with test: false.",
    )


class Stage(_Strict):
    """One deployment of the archive, its own stack, optionally in its own account and region."""

    name: str = PydanticField(pattern=r"^[a-z][a-z0-9-]{0,19}$")
    account: str | None = PydanticField(default=None, pattern=r"^[0-9]{12}$")
    region: str | None = None
    domain: Domain | None = None
    email: Literal["ses"] | None = PydanticField(
        default=None,
        description="ses: send the account emails (sign-up codes, invitations, password resets) "
        "through Amazon SES from no-reply@<domain>, with DKIM records in the domain's hosted "
        "zone. Needs a domain. Left out: Cognito's own email, which is capped per day.",
    )
    doi: StageDoi | None = None
    keep_data: bool = PydanticField(
        default=True,
        alias="keepData",
        description="true: the stage's buckets, tables, user pool and logs are kept when its "
        "stack is deleted, and the tables and user pool are protected from deletion. false: a "
        "disposable stage, deleted whole with its data when it is torn down, with the test "
        "conveniences (uploads from a local web app at http://localhost:5199, and the sign-in "
        "client the end-to-end test uses). Left out: true.",
    )

    @model_validator(mode="after")
    def _domain_and_email_rules(self) -> Self:
        if self.domain is not None and not self.region:
            raise ValueError(
                f"stage {self.name} has a domain, so it needs a region: the certificate is made "
                "in us-east-1 and referenced from the stage's region"
            )
        if self.email is not None and self.domain is None:
            raise ValueError(
                f"stage {self.name} sends email through SES from its domain, so it needs a domain"
            )
        if self.email is not None and self.region in _REGIONS_WITHOUT_SES:
            raise ValueError(
                f"stage {self.name} is in {self.region}, where Cognito can't send through SES in "
                "its own Region; email: ses isn't supported there yet"
            )
        return self


class ObjectLock(_Strict):
    """Write-once locking of the archive bucket, in governance mode."""

    retention_days: PositiveInt = PydanticField(alias="retentionDays")


class Embeddings(_Strict):
    """Semantic search: an embedding on each dataset item and a vector index to search them."""

    model: Literal["amazon.titan-embed-text-v2:0"] = "amazon.titan-embed-text-v2:0"


class Modules(_Strict):
    """The optional parts, each built only when switched on."""

    waf: bool = False
    object_lock: ObjectLock | None = PydanticField(default=None, alias="objectLock")
    embeddings: Embeddings | None = PydanticField(default=None, alias="embeddings")


class Infrastructure(_Strict):
    """Where and how the archive is deployed."""

    stages: list[Stage] = PydanticField(default_factory=lambda: [Stage(name="prod")], min_length=1)
    alert_email: str = PydanticField(alias="alertEmail")
    monthly_budget_usd: PositiveInt = PydanticField(default=50, alias="monthlyBudgetUsd")
    modules: Modules = PydanticField(default_factory=Modules)

    @model_validator(mode="after")
    def _unique_stage_names(self) -> Self:
        names = [stage.name for stage in self.stages]
        if len(names) != len(set(names)):
            raise ValueError("stage names must be unique")
        return self


BRAND_FILE_MAX_BYTES = 200 * 1024
_BRAND_FILE_SUFFIXES = {"logo": (".svg", ".png"), "favicon": (".svg", ".ico")}
# Script, event handlers and foreignObject would run in the app, which serves the logo from its
# own origin. Role and aria-* attributes are refused too, as they were when Cognito's own sign-in
# page took the logo, so a config that passed before still passes the same way.
_SVG_REFUSED_ELEMENTS = {"script", "foreignobject"}


def _svg_refusal(text: str) -> str | None:
    """Why this SVG can't be a brand file, or None when it can."""
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as error:
        return f"isn't a well-formed SVG ({error})"
    for element in root.iter():
        tag = str(element.tag).rsplit("}", 1)[-1]
        if tag.lower() in _SVG_REFUSED_ELEMENTS:
            return f"has a <{tag}> element, which is not allowed"
        for name in element.attrib:
            attribute = name.rsplit("}", 1)[-1]
            if attribute == "role" or attribute.startswith(("aria-", "on")):
                return f"has a {attribute} attribute on <{tag}>, which is not allowed"
    return None


class Brand(_Strict):
    """How the archive presents itself: the app, the sign-in page and the invitation email.

    `logo` and `favicon` are paths relative to the config file; they are checked only when
    the config is loaded from its file, since a deployed copy travels without them.
    """

    name: str | None = PydanticField(default=None, min_length=1, max_length=120)
    intro: str | None = PydanticField(default=None, min_length=1, max_length=600)
    contact: str | None = PydanticField(default=None, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    logo: str | None = None
    favicon: str | None = None
    primary_color: str | None = PydanticField(
        default=None, alias="primaryColor", pattern=r"^#[0-9a-fA-F]{6}$"
    )
    font: str | None = PydanticField(
        default=None, min_length=1, max_length=300, pattern=r"""^[\w ,'"-]+$"""
    )
    # Capped well under the 4 KB SSM parameter the whole config is stored in.
    privacy: str | None = PydanticField(
        default=None,
        min_length=1,
        max_length=2500,
        description="The privacy page's text, in place of the kit's default: plain text, "
        "paragraphs separated by blank lines. No HTML or Markdown is read.",
    )

    @field_validator("logo", "favicon")
    @classmethod
    def _brand_file(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None:
            return None
        field = info.field_name or ""
        suffixes = _BRAND_FILE_SUFFIXES[field]
        if not value.lower().endswith(suffixes):
            raise ValueError(f"the {field} must be one of {', '.join(suffixes)}")
        base = info.context.get("config_dir") if isinstance(info.context, dict) else None
        if base is not None:
            path = Path(base) / value
            if not path.is_file():
                raise ValueError(f"no {field} file at {path}")
            if path.stat().st_size > BRAND_FILE_MAX_BYTES:
                raise ValueError(f"the {field} is over 200 KB")
            if path.suffix.lower() == ".svg":
                refusal = _svg_refusal(path.read_text(encoding="utf-8"))
                if refusal:
                    raise ValueError(f"the {field} {refusal}")
        return value


class Doi(_Strict):
    """The optional DOI module: a findable DataCite DOI for each published version. The
    repository's password is an SSM SecureString, never in this file."""

    repository: str = PydanticField(
        pattern=_DOI_REPOSITORY,
        description="The DataCite repository id (Account ID), such as EXAMPLE.IRC.",
    )
    prefix: str = PydanticField(
        pattern=_DOI_PREFIX,
        description="The repository's DOI prefix from DataCite Fabrica, such as 10.5072.",
    )
    test: bool = PydanticField(
        default=True,
        description="Use DataCite's test system. Keep it true here, and go live on the production "
        "stage alone with that stage's own doi block (test: false and the live repository and "
        "prefix), so no other stage registers DOIs that can never be deleted.",
    )


class ArchiveConfig(ArchiveModel):
    """Which profiles apply, extra required fields, vocabularies, themes, the licenses and
    access levels offered, and the publisher the archive fills in at publish."""

    publisher: str
    profiles: list[str] = PydanticField(default_factory=lambda: ["core"])
    required: list[str] = PydanticField(default_factory=list)
    vocabularies: list[Vocabulary] = PydanticField(default_factory=list)
    themes: list[str] = PydanticField(default_factory=list)
    licenses: list[str] = PydanticField(default_factory=list)
    access: list[AccessLevel] = PydanticField(default_factory=_every_access_level)
    infrastructure: Infrastructure | None = None
    brand: Brand | None = None
    doi: Doi | None = None

    @model_validator(mode="after")
    def _known_fields(self) -> Self:
        check_known_fields(self.required)
        return self

    @model_validator(mode="after")
    def _stage_doi_needs_the_doi_block(self) -> Self:
        if self.doi is None and self.infrastructure is not None:
            for stage in self.infrastructure.stages:
                if stage.doi is not None:
                    raise ValueError(
                        f"stage {stage.name} sets doi, so the archive needs a doi block "
                        "with its repository and prefix"
                    )
        return self

    @model_validator(mode="after")
    def _brand_name_defaults_to_publisher(self) -> Self:
        if self.brand is not None and self.brand.name is None:
            self.brand.name = self.publisher
        return self

    def load_profiles(self) -> list[Profile]:
        return [load_profile(name) for name in self.profiles]


def load_config(path: Path) -> ArchiveConfig:
    """The config at `path`, with its brand files checked beside it."""
    return ArchiveConfig.model_validate(
        yaml.safe_load(path.read_text(encoding="utf-8")),
        context={"config_dir": path.parent},
    )
