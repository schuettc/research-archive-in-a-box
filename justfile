schema_file := "packages/web/src/schema/archive-contract.schema.json"
config_type_file := "packages/infra/src/generated/archive-config.ts"
config_type_generator := "packages/infra/scripts/generate-config-type.ts"
openapi_file := "packages/web/src/schema/openapi.json"
web_types_dir := "packages/web/src/generated"

# Run every check in both languages, plus the schema drift check
check: check-python check-ts check-schema

# Python: format check, lint, type check, tests
check-python:
    uv run ruff format --check
    uv run ruff check
    uv run mypy packages examples/femc scripts
    uv run pytest

# TypeScript: format check, lint, type check, web build, tests (the infra tests synth the build)
check-ts: lambda-assets
    npx prettier --check .
    npx eslint .
    npm run typecheck --workspaces
    npm run build -w packages/web
    npm test --workspaces

# Print the stage names of archive.yaml (or ARCHIVE_CONFIG) as a JSON list, in file order
stages:
    #!/usr/bin/env bash
    set -euo pipefail
    uv run --frozen python - "${ARCHIVE_CONFIG:-archive.yaml}" <<'EOF'
    import json, sys
    from pathlib import Path
    from archive_contract.config import load_config
    config = load_config(Path(sys.argv[1]))
    if config.infrastructure is None:
        sys.exit(f"{sys.argv[1]} needs an infrastructure section")
    print(json.dumps([stage.name for stage in config.infrastructure.stages]))
    EOF

# Start a reindex of the stage's catalog, with the caller's AWS_PROFILE in the stage's region;
# --dois first registers a DOI for every version missing one and re-sends every existing DOI's record
reindex stage *flags:
    #!/usr/bin/env bash
    set -euo pipefail
    payload='{}'
    for flag in {{flags}}; do
        case "$flag" in
            --dois) payload='{"dois": true}' ;;
            *) echo "unknown flag: $flag (the one flag is --dois)"; exit 1 ;;
        esac
    done
    region="$({{just_executable()}} _stage-field "{{stage}}" region)"
    aws() { command aws ${region:+--region "$region"} "$@"; }
    fn="$(aws cloudformation describe-stacks --stack-name "ResearchArchive-{{stage}}" \
        --query "Stacks[0].Outputs[?OutputKey=='ReindexFunction'].OutputValue" --output text)"
    aws lambda invoke --invocation-type Event --function-name "$fn" --payload "$payload" \
        --cli-binary-format raw-in-base64-out /dev/null >/dev/null
    echo "reindex started on {{stage}} with $payload; follow it with just reindex-status {{stage}}"

# Show the status and result of the stage's latest reindex
reindex-status stage:
    #!/usr/bin/env bash
    set -euo pipefail
    region="$({{just_executable()}} _stage-field "{{stage}}" region)"
    aws() { command aws ${region:+--region "$region"} "$@"; }
    fn="$(aws cloudformation describe-stacks --stack-name "ResearchArchive-{{stage}}" \
        --query "Stacks[0].Outputs[?OutputKey=='ReindexFunction'].OutputValue" --output text)"
    # Listing executions can't filter by alias, so list by the function's unqualified ARN.
    arn="$(aws lambda list-durable-executions-by-function --function-name "${fn%:live}" --max-items 1 \
        --query "DurableExecutions[0].DurableExecutionArn" --output text | head -n 1)"
    if [ -z "$arn" ] || [ "$arn" = "None" ]; then
        echo "no reindex has run on {{stage}}"
        exit 1
    fi
    aws lambda get-durable-execution --durable-execution-arn "$arn" \
        --query "{status: Status, result: Result}" --output json

# Print a stage's region or account from archive.yaml (or ARCHIVE_CONFIG), empty when it names none
_stage-field stage field:
    #!/usr/bin/env bash
    set -euo pipefail
    uv run --all-packages --frozen python - "${ARCHIVE_CONFIG:-archive.yaml}" "{{stage}}" "{{field}}" <<'EOF'
    import sys
    from pathlib import Path
    from archive_contract.config import load_config
    path, name, field = sys.argv[1:]
    infrastructure = load_config(Path(path)).infrastructure
    stages = {stage.name: stage for stage in infrastructure.stages} if infrastructure else {}
    if name not in stages:
        sys.exit(f"stage {name} is not in {path}")
    print(getattr(stages[name], field) or "")
    EOF

# Invite a person to the stage by email, optionally into groups: a comma-separated list of contributor, curator and admin
invite-user stage email groups="":
    #!/usr/bin/env bash
    set -euo pipefail
    region="$({{just_executable()}} _stage-field "{{stage}}" region)"
    aws() { command aws ${region:+--region "$region"} "$@"; }
    pool="$({{just_executable()}} _user-pool "{{stage}}")"
    aws cognito-idp admin-create-user --user-pool-id "$pool" --username "{{email}}" \
        --user-attributes Name=email,Value="{{email}}" Name=email_verified,Value=true \
        --desired-delivery-mediums EMAIL >/dev/null
    IFS=',' read -ra groups <<< "{{groups}}"
    for group in "${groups[@]}"; do
        group="${group// /}"
        [ -n "$group" ] || continue
        aws cognito-idp admin-add-user-to-group --user-pool-id "$pool" --username "{{email}}" --group-name "$group"
        # An admin hears of access requests on the Admins topic, as the People page's invite does.
        if [ "$group" = admin ]; then
            topic="$(aws cloudformation list-stack-resources --stack-name "ResearchArchive-{{stage}}" \
                --query "StackResourceSummaries[?ResourceType=='AWS::SNS::Topic' && contains(LogicalResourceId, 'AccessAdmins')].PhysicalResourceId" --output text)"
            aws sns subscribe --topic-arn "$topic" --protocol email --notification-endpoint "{{email}}" >/dev/null
        fi
    done
    echo "invited {{email}} to {{stage}} {{groups}}"

# Make a person's roles exactly the comma-separated list given (contributor, curator, admin); "" removes every role
set-roles stage email roles:
    #!/usr/bin/env bash
    set -euo pipefail
    region="$({{just_executable()}} _stage-field "{{stage}}" region)"
    aws() { command aws ${region:+--region "$region"} "$@"; }
    pool="$({{just_executable()}} _user-pool "{{stage}}")"
    current() { aws cognito-idp admin-list-groups-for-user --user-pool-id "$pool" --username "{{email}}" \
        --query "Groups[].GroupName" --output text | tr '\t' '\n' | sort; }
    before="$(current)"
    want="$(echo "{{roles}}" | tr ',' '\n' | tr -d ' ' | grep -v '^$' | sort -u || true)"
    for group in $(comm -13 <(echo "$before") <(echo "$want")); do
        aws cognito-idp admin-add-user-to-group --user-pool-id "$pool" --username "{{email}}" --group-name "$group"
    done
    for group in $(comm -23 <(echo "$before") <(echo "$want")); do
        aws cognito-idp admin-remove-user-from-group --user-pool-id "$pool" --username "{{email}}" --group-name "$group"
    done
    echo "{{email}} on {{stage}}: $(echo $before | tr ' ' ',') -> $(current | tr '\n' ',' | sed 's/,$//')"

# Move a dataset's embargo to a date (YYYY-MM-DD; today lifts it), as an admin signed in in the browser
set-embargo stage id date:
    #!/usr/bin/env bash
    set -euo pipefail
    region="$({{just_executable()}} _stage-field "{{stage}}" region)"
    domain="$(aws ${region:+--region "$region"} cloudformation describe-stacks \
        --stack-name "ResearchArchive-{{stage}}" \
        --query "Stacks[0].Outputs[?OutputKey=='SiteDomain'].OutputValue" --output text)"
    if [ -z "$domain" ] || [ "$domain" = "None" ]; then
        echo "ResearchArchive-{{stage}} has no SiteDomain output"
        exit 1
    fi
    uv run --all-packages --frozen python - "$domain" "{{id}}" "{{date}}" <<'EOF'
    import json, sys, urllib.error, urllib.parse, urllib.request
    from archive_client.signin import AuthConfig, sign_in
    domain, dataset, until = sys.argv[1:]
    print("signing in: finish it on the archive's sign-in page in the browser")
    tokens = sign_in(AuthConfig(site=f"https://{domain}"))
    request = urllib.request.Request(
        f"https://{domain}/api/admin/datasets/{urllib.parse.quote(dataset, safe='')}/embargo",
        data=json.dumps({"until": until}).encode(),
        # The API's Cognito authorizer takes the ID token as the raw header, with no "Bearer".
        headers={"Authorization": tokens.id_token, "content-type": "application/json"},
        method="PUT",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as answer:
            manifest = json.load(answer)["manifest"]
    except urllib.error.HTTPError as error:
        sys.exit(f"{error.code}: {error.read().decode()}")
    print(f"{dataset}: files available from {manifest['archive:embargoUntil']}")
    EOF

# The stage's user pool id. list-stack-resources pages past 100 resources (describe-stack-resources
# stops there), and a stage that keeps its data has no UserPoolId output.
_user-pool stage:
    #!/usr/bin/env bash
    set -euo pipefail
    region="$({{just_executable()}} _stage-field "{{stage}}" region)"
    aws ${region:+--region "$region"} cloudformation list-stack-resources --stack-name "ResearchArchive-{{stage}}" \
        --query "StackResourceSummaries[?ResourceType=='AWS::Cognito::UserPool'].PhysicalResourceId" --output text

# Check the stage's site with no sign-in: site, health, search, the sample dataset's page and a download.
# CI passes the domain from cdk deploy's outputs; with none, it is read from the stack.
smoke stage domain="":
    #!/usr/bin/env bash
    set -euo pipefail
    domain="{{domain}}"
    if [ -z "$domain" ]; then
        region="$({{just_executable()}} _stage-field "{{stage}}" region)"
        domain="$(aws ${region:+--region "$region"} cloudformation describe-stacks \
            --stack-name "ResearchArchive-{{stage}}" \
            --query "Stacks[0].Outputs[?OutputKey=='SiteDomain'].OutputValue" --output text)"
    fi
    if [ -z "$domain" ] || [ "$domain" = "None" ]; then
        echo "ResearchArchive-{{stage}} has no SiteDomain output"
        exit 1
    fi
    python3 scripts/smoke.py "$domain"

# Publish the sample package on the stage, signed in in the browser as a contributor and curator, and wait for it
seed stage:
    #!/usr/bin/env bash
    set -euo pipefail
    region="$({{just_executable()}} _stage-field "{{stage}}" region)"
    domain="$(aws ${region:+--region "$region"} cloudformation describe-stacks \
        --stack-name "ResearchArchive-{{stage}}" \
        --query "Stacks[0].Outputs[?OutputKey=='SiteDomain'].OutputValue" --output text)"
    if [ -z "$domain" ] || [ "$domain" = "None" ]; then
        echo "ResearchArchive-{{stage}} has no SiteDomain output"
        exit 1
    fi
    uv run --all-packages --frozen python scripts/seed.py "$domain"

# Record the README's demo video and screenshots into demo/out/ on a deployed stage with keepData: false
demo-video stage:
    #!/usr/bin/env bash
    set -euo pipefail
    # It makes three accounts on the stage, publishes the sample packages the stage lacks and makes
    # two submissions, one of them from a Claude Code session that uses the Claude sign-in on
    # this laptop; demo/README.md says what it needs. Run from a laptop, never CI.
    for tool in vhs ffmpeg ffprobe node jq claude; do
        if ! command -v "$tool" >/dev/null; then
            echo "demo-video needs $tool, which is not installed: demo/README.md has the install commands"
            exit 1
        fi
    done
    if [ ! -d demo/node_modules/playwright ]; then
        echo "demo-video needs Playwright, which is not installed: demo/README.md has the install commands"
        exit 1
    fi
    # _stage-field prints True for a stage that keeps its data and nothing for one that doesn't.
    if [ -n "$({{just_executable()}} _stage-field "{{stage}}" keep_data)" ]; then
        echo "{{stage}} keeps its data; demo-video records only on a stage with keepData: false"
        exit 1
    fi
    region="$({{just_executable()}} _stage-field "{{stage}}" region)"
    [ -z "$region" ] || export AWS_DEFAULT_REGION="$region"
    root="$PWD"
    # An earlier take's video and screenshots stay until this take writes its own.
    rm -rf demo/out/raw demo/out/scenes demo/out/captions demo/out/timeline.json
    mkdir -p demo/out/scenes demo/out/screenshots
    # The accounts, the sample datasets, an empty review queue, the two package folders and
    # what the agent scene runs.
    uv run --all-packages --frozen python demo/setup.py "{{stage}}"
    work="$(jq -r .work demo/out/run.json)"
    # The agent scene: Claude Code with the cruise plugin gives the plot survey a title and
    # submits it. The browser scenes then submit the second package and review both.
    (cd "$work" && PATH="$work/.demo/bin:$PATH" vhs "$root/demo/agent.tape")
    mv "$work/agent.mp4" demo/out/scenes/agent-raw.mp4
    mv "$work/demo-agent-session.png" demo/out/scenes/agent-screenshot.png
    # The browser scenes and screenshots, then the six scenes joined under their captions.
    node demo/scenes.mjs
    node demo/assemble.mjs
    echo "the screenshots are in demo/out/screenshots/; watch the video with: open demo/out/research-archive-demo.mp4"

# Delete the stage's stack, the log groups its functions leave behind and, with a domain, its
# certificate stack in us-east-1; run from a laptop, never CI
destroy stage:
    #!/usr/bin/env bash
    set -euo pipefail
    region="$({{just_executable()}} _stage-field "{{stage}}" region)"
    account="$({{just_executable()}} _stage-field "{{stage}}" account)"
    aws() { command aws ${region:+--region "$region"} "$@"; }
    if [ -n "$account" ]; then
        caller="$(aws sts get-caller-identity --query Account --output text)"
        if [ "$caller" != "$account" ]; then
            echo "{{stage}} is in account $account, but you are signed in to $caller; nothing destroyed"
            exit 1
        fi
    fi
    # A running ingest execution (a submission waiting for review) blocks deleting the ingest
    # function's version, and cdk destroy then fails after about ten minutes: stop them first.
    ingest="ResearchArchive-{{stage}}-Ingest"
    if executions="$(aws lambda list-durable-executions-by-function --function-name "$ingest" \
        --query "DurableExecutions[].[DurableExecutionArn,Status]" --output text 2>&1)"; then
        stopped=0
        for arn in $(awk '$2 == "RUNNING" { print $1 }' <<< "$executions"); do
            aws lambda stop-durable-execution --durable-execution-arn "$arn" >/dev/null
            stopped=$((stopped + 1))
        done
        echo "stopped $stopped running ingest execution(s)"
    elif ! grep -q "ResourceNotFoundException" <<< "$executions"; then
        echo "could not list $ingest's executions: $executions"
        exit 1
    fi
    # cdk destroy synthesizes the app, which reads the Lambda bundle and the web build: build
    # both from this checkout first, as CI does before it deploys.
    {{just_executable()}} lambda-assets
    npm run build -w packages/web
    out="$(mktemp)"
    trap 'rm -f "$out"' EXIT
    cdk_destroy() { (cd packages/infra && npx cdk destroy "ResearchArchive-{{stage}}" --force) 2>&1 | tee "$out"; }
    # CloudFront can deliver a log to the derived bucket after CDK's helper emptied it, and the
    # bucket's delete then fails: empty its logs/ and destroy once more.
    if ! cdk_destroy; then
        if ! grep -qE "BucketNotEmpty|bucket you tried to delete is not empty" "$out"; then
            exit 1
        fi
        derived="$(aws cloudformation list-stack-resources --stack-name "ResearchArchive-{{stage}}" \
            --query "StackResourceSummaries[?ResourceType=='AWS::S3::Bucket' && contains(LogicalResourceId, 'Derived')].PhysicalResourceId" --output text)"
        echo "emptying logs/ in $derived, which took a log after it was emptied, and destroying again"
        aws s3 rm "s3://$derived/logs/" --recursive
        cdk_destroy
    fi
    # Lambda makes a log group for each function that runs, and the stack's helpers have none of
    # their own: delete every group under the stage's prefix, but not those of another stage whose
    # name starts with this one's (test-b's under test's).
    prefix="/aws/lambda/ResearchArchive-{{stage}}-"
    others="$({{just_executable()}} stages | jq -r --arg stage "{{stage}}" \
        '.[] | select(startswith($stage + "-")) | "/aws/lambda/ResearchArchive-\(.)-"')"
    for group in $(aws logs describe-log-groups --log-group-name-prefix "$prefix" \
        --query "logGroups[].logGroupName" --output text); do
        for other in $others; do
            [[ "$group" == "$other"* ]] && continue 2
        done
        echo "deleting log group $group"
        aws logs delete-log-group --log-group-name "$group"
    done
    if answer="$(aws cloudformation describe-stacks --stack-name "ResearchArchive-{{stage}}" 2>&1)"; then
        echo "ResearchArchive-{{stage}} still exists"
        exit 1
    fi
    if ! grep -q "does not exist" <<< "$answer"; then
        echo "could not confirm ResearchArchive-{{stage}} is gone: $answer"
        exit 1
    fi
    echo "ResearchArchive-{{stage}} is gone"
    # A stage with a domain has its certificate in a stack of its own in us-east-1. ACM's
    # validation CNAME stays in the hosted zone after the certificate goes, so name it first.
    east() { command aws --region us-east-1 "$@"; }
    cert="ResearchArchive-{{stage}}-Certificate"
    if ! answer="$(east cloudformation describe-stacks --stack-name "$cert" 2>&1)"; then
        if grep -q "does not exist" <<< "$answer"; then
            exit 0
        fi
        echo "could not check for $cert in us-east-1: $answer"
        exit 1
    fi
    arn="$(east cloudformation list-stack-resources --stack-name "$cert" \
        --query "StackResourceSummaries[?ResourceType=='AWS::CertificateManager::Certificate'].PhysicalResourceId" --output text)"
    zone="$(east cloudformation get-template --stack-name "$cert" \
        --query "TemplateBody.Resources.*|[?Type=='AWS::CertificateManager::Certificate']|[0].Properties.DomainValidationOptions[0].HostedZoneId" --output text)"
    cname="$(east acm describe-certificate --certificate-arn "$arn" \
        --query "Certificate.DomainValidationOptions[0].ResourceRecord.Name" --output text)"
    east cloudformation delete-stack --stack-name "$cert"
    east cloudformation wait stack-delete-complete --stack-name "$cert"
    echo "$cert is gone"
    echo "ACM's validation record $cname is still in hosted zone $zone; to remove it:"
    echo "  aws route53 change-resource-record-sets --hosted-zone-id $zone --change-batch \"\$(aws route53 list-resource-record-sets --hosted-zone-id $zone --query \"ResourceRecordSets[?Name=='$cname' && Type=='CNAME'] | [0]\" --output json | jq '{Changes: [{Action: \"DELETE\", ResourceRecordSet: .}]}')\""

# Subscribe a curator's email to the stage's curators' topic, for messages to their user id or to all
add-curator stage email userId:
    #!/usr/bin/env bash
    set -euo pipefail
    region="$({{just_executable()}} _stage-field "{{stage}}" region)"
    aws() { command aws ${region:+--region "$region"} "$@"; }
    topic="$(aws cloudformation describe-stacks --stack-name "ResearchArchive-{{stage}}" \
        --query "Stacks[0].Outputs[?OutputKey=='CuratorTopic'].OutputValue" --output text)"
    attributes="$(jq -cn --arg user '{{userId}}' \
        '{FilterPolicy: ({audience: [$user, "all"]} | tojson)}')"
    aws sns subscribe --topic-arn "$topic" --protocol email --notification-endpoint '{{email}}' \
        --attributes "$attributes" --query SubscriptionArn --output text >/dev/null
    echo "{{email}} subscribed to the {{stage}} curators' topic; they must confirm from the email"

# Drive the sample package through the ingest pipeline on a deployed stage with keepData: false, with the
# caller's AWS_PROFILE and region. Set INGEST_E2E_REVIEWER to your curator user id to receive
# the reminder; the reminder run leaves one submission waiting, and the next day's run checks it.
# With --large it also uploads and publishes a package as large as the stage takes (9 GiB unless
# submissions.maxPackageGiB says less), which needs that much free disk here.
ingest-e2e stage *args:
    uv run --all-packages --frozen python scripts/ingest_e2e.py {{stage}} {{args}}

# Install archive-backend, its workspace packages (the contract and cruise) and its locked
# dependencies as arm64 Lambda wheels, without Docker
lambda-assets:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    rm -rf packages/infra/assets/python
    uv export --package archive-backend --no-dev --no-hashes --frozen --no-emit-workspace -o "$tmp/requirements.txt"
    # manylinux_2_28: DuckDB ships no older aarch64 wheel; the python3.13 runtime (AL2023) has glibc 2.34.
    uv pip install --python-platform aarch64-manylinux_2_28 --python-version 3.13 --only-binary :all: --target packages/infra/assets/python -r "$tmp/requirements.txt"
    uv pip install --no-deps --python-version 3.13 --target packages/infra/assets/python packages/contract packages/tool packages/backend

# Fail when the committed JSON Schema, the construct's config type or the OpenAPI spec differs from the code
check-schema:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    uv run python -m archive_contract.schema "$tmp/schema.json"
    diff -u {{schema_file}} "$tmp/schema.json"
    npx tsx {{config_type_generator}} "$tmp/schema.json" "$tmp/archive-config.ts"
    diff -u {{config_type_file}} "$tmp/archive-config.ts"
    uv run python -m archive_backend.api "$tmp/openapi.json"
    diff -u {{openapi_file}} "$tmp/openapi.json"
    just web-types "$tmp/web"
    diff -ru {{web_types_dir}} "$tmp/web"

# Rewrite the committed JSON Schema and the construct's config type from the contract
schema:
    uv run python -m archive_contract.schema {{schema_file}}
    npx tsx {{config_type_generator}} {{schema_file}} {{config_type_file}}

# Rewrite the committed OpenAPI spec from the read API's routes
openapi:
    uv run python -m archive_backend.api {{openapi_file}}

# Write the web app's API and manifest types from the committed OpenAPI spec and JSON Schema
web-types out=web_types_dir:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "{{out}}"
    out="$(cd "{{out}}" && pwd)"
    root="$PWD"
    (cd packages/web && npx openapi-typescript "$root/{{openapi_file}}" -o "$out/api.ts" >/dev/null)
    npx json2ts -i {{schema_file}} -o "$out/manifest.ts" --no-format \
        --bannerComment="// Generated from the archive contract's JSON Schema by \`just web-types\`. Do not edit."
    npx prettier --config .prettierrc --write "$out/api.ts" "$out/manifest.ts" >/dev/null

# Format Python and TypeScript in place
fmt:
    uv run ruff format
    uv run ruff check --fix
    npx prettier --write .
