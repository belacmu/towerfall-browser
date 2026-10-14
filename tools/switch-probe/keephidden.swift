// keephidden <pid> <seconds>: keeps that app hidden (re-hides within ~20 ms if it shows or activates),
// then exits. Counts, after the first second, how often it had un-hidden and how often it was active.
import AppKit
let pid = pid_t(CommandLine.arguments[1])!, secs = Double(CommandLine.arguments[2])!
let start = Date(); var unhid = 0, active = 0
while Date().timeIntervalSince(start) < secs {
  guard let app = NSRunningApplication(processIdentifier: pid) else { break }
  let late = Date().timeIntervalSince(start) > 1
  if app.isActive && late { active += 1 }
  if !app.isHidden && late { unhid += 1 }
  if !app.isHidden || app.isActive { app.hide() }
  usleep(20_000)
}
print("after startup: un-hidden \(unhid)x, active \(active)x")
