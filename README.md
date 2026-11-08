# Ram-Altman for macOS

A macOS port of [IainKay/ram-altman](https://github.com/IainKay/ram-altman), with Linux support preserved. Runs with the Bash 3.2 and BSD tools shipped by macOS; no Homebrew dependencies.

**A bash script that writes to Sam Altman once a day to report the RAM he missed.**

Read the sample emails at **[ram-altman.lol](https://ram-altman.lol)**, no install needed.

[![Website: ram-altman.lol](https://img.shields.io/badge/website-ram--altman.lol-0f5a43)](https://ram-altman.lol)
![Global DRAM allocation: quite terrible](https://img.shields.io/badge/global%20DRAM%20allocation-quite%20terrible-red)
![Utilization: maybe 5%](https://img.shields.io/badge/utilization-maybe%205%25-orange)
![Emails: 1 per day](https://img.shields.io/badge/emails-1%20per%20day-blue)
![Written in Bash, not Electron](https://img.shields.io/badge/written%20in-bash%2C%20not%20electron-brightgreen)

There is RAM in your computer. Right now. Just sitting there, in a *personal* computer, being personal.

You may have thought of this as "a computer working normally". On a recent episode of [Cheeky Pint](https://gizmodo.com/sam-altman-youre-completely-right-about-ram-im-sorry-for-the-confusion-heres-what-happened-2000835208), the CEO of OpenAI offered another view:

> "From a global allocation perspective, actually, it's quite terrible to have everybody have a bunch of the world's limited supply of DRAM sitting in their own computer"
>
> — Sam Altman

That RAM, he added, is ["being used maybe 5% of the time"](https://www.xda-developers.com/sam-altman-says-its-quite-terrible-that-people-have-ram-in-their-pcs-during-a-shortage/).

Which raised an obvious question for a certain kind of person: *surely someone should be monitoring this?*

So we wrote a script. If your machine has more than 10% of its RAM available, it sends one email a day to let Sam know. It seemed only fair. He can't fix the problem if nobody tells him where the RAM is.

## Features

- Tracks total, used and available RAM, plus your standing with the global allocation authorities
- Handles page cache correctly, which already puts it ahead of most arguments about RAM
- Sends at most one email per day, because we're hoarders, not animals
- Rotates 8 subject lines, 10 messages and 6 sign-offs, so the joke gets old at a carefully managed pace
- Logs every sample to CSV for when the auditors arrive
- Tests Linux and macOS memory accounting, delivery limits, failure handling and locking
- Is written in bash, as an Electron version would have solved the problem by using all the RAM

## A sample of today's correspondence

```text
Subject: You missed a spot

Hi Sam,

Please don't be alarmed, but there is 8.6 GiB of RAM on my desk that isn't in
a data centre. That's 56.2% of what's installed here, and as far as I can tell
it has no plans today.

Hoarding responsibly,
A concerned RAM owner

--
Sent automatically, at most once a day, by a small script on one PC.
Reply if you'd like it to stop.
```

The figures are real. They come from your machine. That's the worrying part.

## macOS memory accounting

On macOS, total RAM comes from `sysctl -n hw.memsize`. Available RAM is
**estimated** as free + inactive + speculative pages from `vm_stat`, using the
page size in its header (including 4 KiB Intel and 16 KiB Apple Silicon pages).
Used RAM is total minus that estimate. Inactive pages can include anonymous
memory that needs compression or swapping, so this is not a promise that all
of it can be allocated without swapping, nor an Activity Monitor replica.

`vm_stat` displays free pages with speculative pages subtracted, so adding
speculative pages here counts them once. Purgeable pages overlap the other
queues and are not added again. Compressed and wired memory count as used.
See [Apple’s vm_stat implementation](https://github.com/apple-oss-distributions/system_cmds/blob/main/vm_stat/vm_stat.c).
The status output labels the estimate explicitly.

## Linux memory accounting

```text
used = MemTotal - MemAvailable
```

`MemAvailable` is the kernel's own estimate of how much memory programs could claim without swapping. Free RAM counts as available. So does cache the kernel can reclaim. tmpfs and shared memory don't, because they can't simply be handed back.

Every sysadmin has spent years explaining that [Linux didn't eat your RAM](https://www.linuxatemyram.com/) and that free RAM is wasted RAM. It took decades for someone important to agree with the second part, and he'd like it shipped to him.

Strictly speaking, the page cache is doing useful work, so counting it as available is a generous concession to the other side. Think of it as a plea bargain.

On kernels older than 3.14, which have no `MemAvailable`, the script estimates it from free memory plus reclaimable cache. If you're on one of those, your RAM may be safe. Nobody's coming for that.

## Installation

You'll need macOS or Linux and bash. Status and dry runs need no mail setup.
Actual sending requires a configured `sendmail`, `msmtp` or `mail` transport;
the macOS mail binaries alone do not provide a working SMTP account.

```bash
git clone https://github.com/pxcd/ram-altman-macos.git
cd ram-altman-macos
chmod +x ram-altman.sh test-ram-altman.sh

./ram-altman.sh --status    # see the evidence against you
./ram-altman.sh --dry-run   # preview an email without sending it
```

Example output, from a simulated machine that has confessed to everything:

```text
Total:      15.3 GiB
Used:       6.7 GiB
Available:  8.6 GiB (56.2%)
  Free:     0.3 GiB
  Cache:    8.2 GiB
```

To run it for real, add this to your crontab with `crontab -e`:

```cron
RAM_ALTMAN_TO=recipient@example.com
RAM_ALTMAN_FROM=you@example.com
RAM_ALTMAN_FROM_NAME=Your Name

*/5 * * * * /path/to/ram-altman.sh
```

It samples every five minutes and emails at most once a day. If a send fails, it tries again on the next run, because this message matters.

| Setting | What it does | Default |
| --- | --- | --- |
| `RAM_ALTMAN_TO` | Who receives the bad news | Required |
| `RAM_ALTMAN_FROM` | A real address you can send from | Required |
| `RAM_ALTMAN_FROM_NAME` | Your name, or your nom de RAM | Optional |
| `RAM_ALTMAN_THRESHOLD` | Email when available RAM is above this percentage (whole number) | `10` |
| `RAM_ALTMAN_STATE_DIR` | Where the log and state files live | macOS: `~/Library/Application Support/ram-altman`; Linux: `${XDG_STATE_HOME:-~/.local/state}/ram-altman` |

On macOS you can also schedule it as a user LaunchAgent. Save the following as
`~/Library/LaunchAgents/lol.ram-altman.plist`, replacing the absolute script path
and example addresses. XML-escape values containing `&`, `<` or `>`.
This is opt-in: cloning or running tests installs no job and sends no real email.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>lol.ram-altman</string>
    <key>ProgramArguments</key>
    <array><string>/absolute/path/to/ram-altman.sh</string></array>
    <key>StartInterval</key><integer>300</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>RAM_ALTMAN_TO</key><string>recipient@example.com</string>
        <key>RAM_ALTMAN_FROM</key><string>you@example.com</string>
        <key>RAM_ALTMAN_FROM_NAME</key><string>Your Name</string>
    </dict>
</dict>
</plist>
```

Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/lol.ram-altman.plist`.
Stop it with `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/lol.ram-altman.plist`.
It samples while you are logged in; missed intervals during sleep are not replayed.

Overlapping runs use an atomic directory lock on both platforms. If the process
is forcibly killed or the machine loses power, first ensure no instance is still
running, then remove the empty `run.lock` directory inside the state directory
with `rmdir`. It is deliberately not stolen automatically while a mailer might
still be sending.

## Audit yourself

Let it run for a while, then find out how your machine compares:

```bash
awk -F, 'NR>1 { used += $3; total += $2 }
  END { if (total) printf "Your RAM in use: %.1f%% (the claim: maybe 5%%)\n", used * 100 / total }' \
  "$HOME/Library/Application Support/ram-altman/usage.csv"
```

Yes, share of memory in use isn't the same thing as share of time spent in use. If you came here to say that, welcome to Hacker News. We're glad you're here.

## Please be a good neighbour

One email a day from one person is a joke. Ten thousand of them is a denial-of-service attack with better material.

- **`--dry-run` is the best way to enjoy this.** It costs nothing and all the jokes are there.
- **This repo doesn't ship with anyone's email address,** and please don't add one.
- **Use your own real address.** No spoofing, and no running it across your server fleet.
- **If anyone asks you to stop, stop.** The footer of every email promises this, so keep the promise.

You can also point it at someone who will enjoy it, like the friend who has been waiting for DDR5 prices to come down.

## FAQ

**Does this help with the DRAM shortage?**
No.

**Is this a serious tool?**
The memory accounting is. The correspondence isn't.

**Does it work on macOS?**
Yes. This fork reads `vm_stat` and `sysctl` on macOS and `/proc/meminfo` on Linux. Your soldered RAM remains the hardest target in the global allocation programme.

**Why is the threshold 10%?**
Below that, your machine has suffered enough.

**Does running this use RAM?**
Briefly. It's then returned to the global pool, which is more than can be said for the rest of us.

**Can I run the tests without emailing anyone?**
Yes. `./test-ram-altman.sh` uses simulated memory and a fake `sendmail`. No inboxes are harmed.

**Can I see it without installing anything?**
Yes. [ram-altman.lol](https://ram-altman.lol) cycles through the real emails, with sample figures.

**What should I do with all this RAM?**
Open another browser tab. You've still got time.

## In fairness to Sam

Altman has since [said the remarks were taken out of context](https://gizmodo.com/sam-altman-youre-completely-right-about-ram-im-sorry-for-the-confusion-heres-what-happened-2000835208), writing:

> "i actually do want the world to have tons of memory and people to put as much as they want in their computers"

He [followed up](https://www.gadgetreview.com/sam-altman-says-he-wants-you-to-have-even-more-ram-not-less-changes-name-to-ram-altman) with "i want you to have so much ram" and "lets build more", and briefly changed his display name on X to Ram Altman, which is objectively excellent and is where this project gets its name.

The original remarks [came up in a discussion of running AI models locally](https://www.engadget.com/2303266/sam-altman-says-its-terrible-dram-computer/), and the utilization argument is a real one: servers really are busier than your desktop. We just think it's funnier to reply with cron.

Besides, if he wants you to have so much RAM, then this script isn't a complaint at all. It's a daily progress report.

## License

Free as in unallocated.
