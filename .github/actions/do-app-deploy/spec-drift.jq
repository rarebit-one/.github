# spec-drift.jq: list every path where the spec DigitalOcean now holds differs
# from the spec we meant it to hold.
#
# Usage:
#   jq -n -r --slurpfile want <expected.json> --slurpfile got <actual.json> -f spec-drift.jq
#
#   want = the spec as fetched BEFORE the write, plus the intended patch
#          (i.e. exactly the body that was PUT)
#   got  = the spec DO returned from the PUT (or a fresh GET afterwards)
#
# Prints one line per difference, "<KIND> <path>", where KIND is MISSING (in
# want, not in got), ADDED (in got, not in want) or CHANGED. No output means no
# drift. A whole missing or added subtree is reported once, at its root
# (`MISSING services[0=web].liveness_health_check`), not leaf by leaf. VALUES ARE
# NEVER PRINTED: specs carry env values, and SECRET ones as EV[...] ciphertext.
# Array elements are labelled with their `name` (components) or `key` (envs) when
# they have one, purely for readability; comparison is always by index.
#
# NORMALISATION: exactly one rule, and it is representational, not semantic.
#   - An object key whose value is null is treated as absent. App Platform's API
#     omits empty fields, and absent vs explicit null decode identically on its
#     side, so this cannot hide a dropped setting: a dropped setting had a
#     non-null value, and that value is still compared.
# Nothing else is normalised. Measured 2026-11-11: POST /v2/apps/propose (DO's
# non-mutating validator) returned the live jumpdrive-broker spec with no path
# differences at all, EV[...] secret ciphertexts and array order included. If a
# real deploy ever shows DO rewriting something else, add it HERE, with the
# evidence, rather than loosening the comparison.
#
# EXACT MODE: `--argjson exact true` turns the image.registry rule below off,
# leaving only the null rule. That is for comparing two specs WE produced (an
# operator's live spec vs the spec they intend to write: do-spec-edit.sh's
# change listing), where an added registry is a requested change, not DO
# filling one in. The default, used after every write, is unchanged.
#
# Pinned by tests/do-app-deploy-spec.test.sh.

# DO legitimately fills in image.registry (the account's registry name) on a
# DOCR image that we wrote without one; observed on fundbright-web staging,
# 2026-11-11 (run 43032944278: ADDED services[...].image.registry). Remove it
# from GOT only where WANT's image is DOCR and has no registry, so a registry
# that WE set and DO then changed still counts as drift. Components are
# matched by index, as DO keeps their order. sidekick-labs/.github's
# do-app-deploy normalises the same field the same way.
def drop_filled_docr_registry($want):
  reduce (
    ("services", "workers", "jobs", "static_sites", "functions") as $k
    | ($want[$k] // [] | if type == "array" then to_entries[] else empty end)
    | select((.value.image | type) == "object"
             and .value.image.registry_type == "DOCR"
             and (.value.image | has("registry") | not))
    | [$k, .key, "image"]
  ) as $img (.;
    if (try getpath($img) catch null | type) == "object" then delpaths([$img + ["registry"]]) else . end);
def norm: walk(if type == "object" then with_entries(select(.value != null)) else . end);

# A leaf is a scalar or an empty container.
def leaf: if type == "object" or type == "array" then length == 0 else true end;

# Does `$doc` contain path `$p`?
def present($doc; $p):
  if ($p | length) == 0 then true
  else ($doc | try (getpath($p[:-1])
          | if type == "object" then (($p[-1] | type) == "string" and has($p[-1]))
            elif type == "array" then (($p[-1] | type) == "number" and $p[-1] < length)
            else false end) catch false)
  end;

# The shortest prefix of `$p` that is absent from `$doc` (the subtree root).
def absent_root($doc; $p):
  first(range(1; ($p | length) + 1) as $i | $p[:$i] | select(present($doc; .) | not)) // $p;

def pretty($doc):
  . as $p
  | reduce range(0; $p | length) as $i ({s: "", d: $doc};
      $p[$i] as $k
      | if ($k | type) == "number" then
          (.d | if type == "array" then .[$k] else null end) as $e
          | .s += "[\($k)"
                + (if ($e | type) == "object" and (($e.name // $e.key) | type) == "string"
                   then "=" + ($e.name // $e.key) else "" end)
                + "]"
        else .s += (if .s == "" then "" else "." end) + $k
        end
      | .d = (.d | if type == "object" or type == "array" then (try .[$k] catch null) else null end))
  | .s;

($want[0] | norm) as $W
| ($got[0] | norm | if ($ARGS.named.exact // false) then . else drop_filled_docr_registry($W) end) as $G
| ([$W | paths(leaf)] + [$G | paths(leaf)] | unique) as $all
| [ $all[] as $p
    | present($W; $p) as $inW
    | present($G; $p) as $inG
    | if $inW and ($inG | not) then {k: "MISSING", p: absent_root($G; $p), d: $W}
      elif $inG and ($inW | not) then {k: "ADDED", p: absent_root($W; $p), d: $G}
      elif ($W | getpath($p)) != ($G | getpath($p)) then {k: "CHANGED", p: $p, d: $W}
      else empty
      end
  ]
| unique_by([.k, .p])
| .[]
| . as $r
| "\($r.k) \($r.p | pretty($r.d))"
