// Opt-in numeric/admission checks, never linked into the shipped helper.
#include "pointer-input.hpp"
#include <cassert>
#include <limits>

using namespace cafe;
int main() {
  for (const auto value : {int64_t(-relative_motion_limit), int64_t(-1), int64_t(0), int64_t(1), relative_motion_limit}) {
    auto j = object();
    put(j.get(), "dx256", value);
    assert(relative_motion(j.get(), "dx256") == value);
  }
  for (const auto value : {std::string("{}"), std::string("{\"dx256\":1.5}"),
       std::string("{\"dx256\":\"1\"}"), std::string("{\"dx256\":true}"),
       std::string("{\"dx256\":2097153}"), std::string("{\"dx256\":-2097153}"),
       std::string("{\"dx256\":9223372036854775807}")}) {
    auto j = parse(value);
    bool rejected = false;
    try { relative_motion(j.get(), "dx256"); } catch (const std::runtime_error &) { rejected = true; }
    assert(rejected);
  }
  auto motion = [](int64_t x, int64_t y) {
    auto j = object();
    put(j.get(), "kind", std::string("relative-move"));
    put(j.get(), "controlEpoch", int64_t(1));
    put(j.get(), "dx256", x); put(j.get(), "dy256", y);
    return j;
  };
  auto a = motion(100, -50), b = motion(-20, 75);
  assert(coalesce_relative_motion(a.get(), b.get()));
  assert(integer(b.get(), "dx256") == 80 && integer(b.get(), "dy256") == 25);
  auto edge = motion(relative_motion_limit, 0), overflow = motion(1, 0);
  assert(!coalesce_relative_motion(edge.get(), overflow.get()));
  assert(integer(overflow.get(), "dx256") == 1);
  put(b.get(), "controlEpoch", int64_t(2));
  assert(!coalesce_relative_motion(a.get(), b.get()));
  put(b.get(), "controlEpoch", int64_t(1));
  put(b.get(), "kind", std::string("button"));
  assert(!coalesce_relative_motion(a.get(), b.get()));
}
