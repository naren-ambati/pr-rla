# pr-rla CI exit-code mapping (functional-design.md U7; contracts.md section 7). POSIX sh.
# Sourced, never run: it defines two functions and has no side effects.
#
#   prrla_check_fail_on LIST   returns 0 when LIST holds only known names, else says which on stderr
#   prrla_decide RC FAIL_ON    sets PRRLA_RESULT (pass or fail) and PRRLA_REASON; returns 0 on pass, 1 on fail
#
#   0 pass | 1 always fail | 2 escalate | 3 refusal | 4 always fail (re-run it) | 5 timestamps | 6 incomplete
#   Codes 2, 3, 5 and 6 fail only when FAIL_ON names them. Any other code (a missing binary, a signal) fails.
#
# The same text sits between the two marker lines in integrations/gitlab/templates/pr-rla.yml and
# docs/ci/bitbucket.md; test/ci-integrations.test.ts keeps the three identical.

# >>> pr-rla exit map
prrla_check_fail_on() {
  prrla_list=$(printf '%s' "$1" | tr -d ' \t\r\n')
  prrla_oldifs=$IFS
  IFS=,
  for prrla_name in $prrla_list; do
    case "$prrla_name" in
      escalate | refusal | timestamps | incomplete | "") ;;
      *)
        IFS=$prrla_oldifs
        echo "fail-on: unknown name '$prrla_name' (use escalate, refusal, timestamps, incomplete)" >&2
        return 1
        ;;
    esac
  done
  IFS=$prrla_oldifs
  return 0
}

prrla_decide() {
  prrla_rc=$1
  prrla_on=",$(printf '%s' "$2" | tr -d ' \t\r\n'),"
  PRRLA_RESULT=fail
  case "$prrla_rc" in
    0)
      PRRLA_RESULT=pass
      PRRLA_REASON="exit 0"
      return 0
      ;;
    1)
      PRRLA_REASON="exit 1: a check failed, a precondition was not met, or pr-rla refused the command"
      return 1
      ;;
    4)
      PRRLA_REASON="exit 4: pr-rla stopped before it finished; running the printed command again finishes it"
      return 1
      ;;
    2)
      prrla_name=escalate
      prrla_what="exit 2: ESCALATE (the sequential test cannot certify), or the seed round is not yet published"
      ;;
    3)
      prrla_name=refusal
      prrla_what="exit 3: the population is below the registered minimum (review every change instead)"
      ;;
    5)
      prrla_name=timestamps
      prrla_what="exit 5: a record was written with too few trusted timestamps"
      ;;
    6)
      prrla_name=incomplete
      prrla_what="exit 6: INCOMPLETE (nothing failed, but part of the population could not be rebuilt or shown complete)"
      ;;
    *)
      PRRLA_REASON="exit $prrla_rc: not a pr-rla exit code (pr-rla did not run to its end)"
      return 1
      ;;
  esac
  case "$prrla_on" in
    *",$prrla_name,"*)
      PRRLA_REASON="$prrla_what; fail-on includes $prrla_name"
      return 1
      ;;
  esac
  PRRLA_RESULT=pass
  PRRLA_REASON="$prrla_what; fail-on does not include $prrla_name, so the job passes"
  return 0
}
# <<< pr-rla exit map
