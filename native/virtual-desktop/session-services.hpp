#pragma once
#include <string>

namespace cafe {
void prepare_session_services(const std::string &directory,
                              const std::string &helper,
                              const std::string &host_bus);
int session_services(const std::string &configuration);
} // namespace cafe
