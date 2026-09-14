// Opt-in native integration fixture, never linked into the shipped helper.
#include <SDL3/SDL.h>
#include <fstream>
#include <string>

int main(int argc, char **argv) {
  if (argc != 3 || !SDL_Init(SDL_INIT_VIDEO))
    return 1;
  auto window = SDL_CreateWindow("Cafe desktop input fixture", 800, 600,
                                 SDL_WINDOW_RESIZABLE);
  auto renderer = SDL_CreateRenderer(window, nullptr);
  if (!window || !renderer)
    return 2;
  SDL_StartTextInput(window);
  // The viewer cursor test hides only this synthetic guest's cursor, making
  // the host cursor independently observable in an outer desktop screenshot.
  if (SDL_getenv("CAFE_CODE_FIXTURE_HIDE_CURSOR"))
    SDL_HideCursor();
  std::ofstream output(argv[1], std::ios::app);
  output << "driver " << SDL_GetCurrentVideoDriver() << "\n" << std::flush;
  std::string typed;
  int clicks = 0;
  bool running = true;
  while (running) {
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
      if (event.type == SDL_EVENT_QUIT)
        running = false;
      if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN) {
        clicks++;
        output << "click " << event.button.x << " " << event.button.y << "\n"
               << std::flush;
      }
      if (event.type == SDL_EVENT_MOUSE_BUTTON_UP)
        output << "button-up " << unsigned(event.button.button) << "\n" << std::flush;
      if (event.type == SDL_EVENT_KEY_UP)
        output << "released " << event.key.scancode << "\n" << std::flush;
      if (event.type == SDL_EVENT_KEY_DOWN && event.key.scancode == SDL_SCANCODE_F12 && !event.key.repeat) {
        const bool enabled = !SDL_GetWindowRelativeMouseMode(window);
        output << "capture " << enabled << " " << SDL_SetWindowRelativeMouseMode(window, enabled) << "\n" << std::flush;
      }
      if (event.type == SDL_EVENT_MOUSE_MOTION && SDL_GetWindowRelativeMouseMode(window))
        output << "motion " << event.motion.xrel << " " << event.motion.yrel << "\n" << std::flush;
      if (event.type == SDL_EVENT_TEXT_INPUT) {
        typed += event.text.text;
        output << "text " << event.text.text << "\n" << std::flush;
      }
    }
    SDL_SetRenderDrawColor(renderer, 25, 45, 70, 255);
    SDL_RenderClear(renderer);
    SDL_FRect left{100, 150, 240, 180}, right{430, 150, 240, 180};
    SDL_SetRenderDrawColor(renderer, 210, 45, 40, 255);
    SDL_RenderFillRect(renderer, &left);
    SDL_SetRenderDrawColor(renderer, 30, 180, 75, 255);
    SDL_RenderFillRect(renderer, &right);
    SDL_SetRenderDrawColor(renderer, 255, 255, 255, 255);
    SDL_SetRenderScale(renderer, 3, 3);
    SDL_RenderDebugText(renderer, 30, 20,
                        (std::string("CODE ") + argv[2]).c_str());
    SDL_RenderDebugText(renderer, 35, 140,
                        ("Clicks: " + std::to_string(clicks)).c_str());
    SDL_RenderDebugText(renderer, 35, 160, typed.c_str());
    SDL_SetRenderScale(renderer, 1, 1);
    SDL_RenderPresent(renderer);
    SDL_Delay(16);
  }
  SDL_DestroyRenderer(renderer);
  SDL_DestroyWindow(window);
  SDL_Quit();
  return 0;
}
