// Toy spec exercising every ITF value shape quint-connect-sol lowers:
// int, bool, a payload-free sum, a set of ints, and a map to a record.
module counter {
  pure val MAX_KEYS = 4
  pure val LIMIT = 100

  type Status = Idle | Running | Done

  type Entry = { hits: int, flagged: bool }

  var count: int
  var status: Status
  var seen: Set[int]
  var entries: int -> Entry

  action init = all {
    count' = 0,
    status' = Idle,
    seen' = Set(),
    entries' = Map(),
  }

  action increment = {
    nondet by = 1.to(10).oneOf()
    all {
      status != Done,
      count + by <= LIMIT,
      count' = count + by,
      status' = Running,
      seen' = seen.union(Set(by)),
      entries' = entries,
    }
  }

  action touch = {
    nondet key = 0.to(MAX_KEYS - 1).oneOf()
    all {
      status != Done,
      entries' =
        if (entries.keys().contains(key))
          entries.setBy(key, e => { hits: e.hits + 1, flagged: e.hits + 1 >= 2 })
        else
          entries.put(key, { hits: 1, flagged: false }),
      count' = count,
      status' = Running,
      seen' = seen,
    }
  }

  action finish = all {
    status == Running,
    status' = Done,
    count' = count,
    seen' = seen,
    entries' = entries,
  }

  action step = any { increment, touch, finish }

  val inv_countBounded = count >= 0 and count <= LIMIT
  val inv_entriesBounded = entries.keys().forall(k => k >= 0 and k < MAX_KEYS)
  val allInvariants = inv_countBounded and inv_entriesBounded
}
