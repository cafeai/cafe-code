#pragma once
#include "common.hpp"

namespace cafe {
// Wayland motion uses signed 24.8 fixed point. Bound individual/coalesced
// displacement to 8192 pixels, comfortably above one desktop width while
// retaining fractional SDL motion without risking protocol integer overflow.
constexpr int64_t relative_motion_limit = 8192 * 256;
inline int32_t relative_motion(json_object *j, const char *key) {
  auto value = field(j, key);
  if (!value || !json_object_is_type(value, json_type_int))
    throw std::runtime_error("invalid_coordinates");
  const auto delta = json_object_get_int64(value);
  if (delta < -relative_motion_limit || delta > relative_motion_limit)
    throw std::runtime_error("invalid_coordinates");
  return int32_t(delta);
}
inline bool coalesce_relative_motion(json_object *previous, json_object *next) {
  if (str(previous, "kind") != "relative-move" ||
      str(next, "kind") != "relative-move" ||
      integer(previous, "controlEpoch", -1) != integer(next, "controlEpoch", -1))
    return false;
  const auto dx =
      int64_t(relative_motion(previous, "dx256")) + relative_motion(next, "dx256");
  const auto dy =
      int64_t(relative_motion(previous, "dy256")) + relative_motion(next, "dy256");
  if (dx < -relative_motion_limit || dx > relative_motion_limit ||
      dy < -relative_motion_limit || dy > relative_motion_limit)
    return false;
  put(next, "dx256", dx);
  put(next, "dy256", dy);
  return true;
}
} // namespace cafe
