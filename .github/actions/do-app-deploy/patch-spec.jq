# patch-spec.jq: repoint App Platform components at a DOCR image.
#
# Input: the RAW app spec, i.e. `.app.spec` from GET /v2/apps/{id}. It is raw
# JSON from the API, never a client's re-serialisation, so fields that no
# client knows about pass through untouched (fundbright/delivery-ops#1019).
#
# Args:
#   --argjson names '<json array>'  component names to patch; [] = every one
#   --arg repo <DOCR repository>
#   --arg sha  <image tag>
#
# The ONLY change: for each selected service, worker and job, drop its git
# source (`github`, `dockerfile_path`, `source_dir`) and replace its `image`
# block with {registry_type: DOCR, repository, tag}. Every other byte of the spec
# is carried over as read.
#
# Names match EXACTLY. A component array that is absent stays absent (no
# `"workers": null` appears in the PUT body).
#
# Pinned by tests/do-app-deploy-spec.test.sh.

def wanted: ($names | length) == 0 or (.name as $n | any($names[]; . == $n));

def repoint:
  del(.dockerfile_path, .source_dir, .github)
  | .image = {registry_type: "DOCR", repository: $repo, tag: $sha};

reduce ("services", "workers", "jobs") as $k (.;
  if (.[$k] | type) == "array"
  then .[$k] |= map(if wanted then repoint else . end)
  else .
  end)
