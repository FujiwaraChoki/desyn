//! `Array.prototype.sort` as V8 implements it (TimSort, `third_party/v8/builtins/array-sort.tq`), for builders that
//! must order items exactly like their `@desyn/doc-ops` counterparts.
//!
//! Two reasons not to use `slice::sort_by`: some reference comparators are not total orders (tidy's "same row
//! within half a cell" rule is not transitive), and the standard library may panic on such comparators, while
//! JavaScript just produces an order. For a consistent comparator every stable sort agrees, so the port only
//! matters for the inconsistent case, where it reproduces V8's result step for step.

use core::cmp::Ordering;

/// Galloping threshold (`kMinGallopWins`).
const MIN_GALLOP: usize = 7;

/// JavaScript comparator semantics for a numeric difference `a - b` (`NaN` counts as equal).
#[inline]
pub(crate) fn js_order(diff: f64) -> Ordering {
    if diff < 0.0 {
        Ordering::Less
    } else if diff > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// Sorts `v` in place exactly like V8's `Array.prototype.sort(cmp)`. Never panics, whatever `cmp` returns.
pub(crate) fn sort_by<T: Clone, F: FnMut(&T, &T) -> Ordering>(v: &mut [T], cmp: F) {
    let n = v.len();
    if n < 2 {
        return;
    }
    let mut s = State {
        a: v,
        cmp,
        min_gallop: MIN_GALLOP,
        runs: Vec::new(),
    };
    // Arrays shorter than 8 skip run detection: one binary insertion sort over everything (observable through the
    // comparison sequence, e.g. 6 comparisons for 5 sorted items instead of 4).
    if n < 8 {
        s.binary_insertion_sort(0, 0, n);
        return;
    }
    let min_run = min_run_length(n);
    let (mut low, mut remaining) = (0, n);
    while remaining != 0 {
        let mut run = s.count_and_make_run(low, low + remaining);
        if run < min_run {
            let forced = min_run.min(remaining);
            s.binary_insertion_sort(low, low + run, low + forced);
            run = forced;
        }
        s.runs.push((low, run));
        s.merge_collapse();
        low += run;
        remaining -= run;
    }
    s.merge_force_collapse();
}

fn min_run_length(mut n: usize) -> usize {
    let mut r = 0;
    while n >= 64 {
        r |= n & 1;
        n >>= 1;
    }
    n + r
}

struct State<'a, T, F> {
    a: &'a mut [T],
    cmp: F,
    min_gallop: usize,
    /// Pending runs `(base, length)`.
    runs: Vec<(usize, usize)>,
}

/// Where a gallop searches: the array being sorted or the merge's temporary copy.
#[derive(Clone, Copy)]
enum Src {
    Array,
    Temp,
}

impl<T: Clone, F: FnMut(&T, &T) -> Ordering> State<'_, T, F> {
    #[inline]
    fn less(&mut self, x: &T, y: &T) -> bool {
        (self.cmp)(x, y) == Ordering::Less
    }

    fn count_and_make_run(&mut self, low_arg: usize, high: usize) -> usize {
        let low = low_arg + 1;
        if low == high {
            return 1;
        }
        let mut run = 2;
        let (lo, pre) = (self.a[low].clone(), self.a[low - 1].clone());
        let descending = self.less(&lo, &pre);
        let mut previous = lo;
        for idx in low + 1..high {
            let current = self.a[idx].clone();
            let lt = self.less(&current, &previous);
            if descending != lt {
                break;
            }
            previous = current;
            run += 1;
        }
        if descending {
            self.a[low_arg..low_arg + run].reverse();
        }
        run
    }

    fn binary_insertion_sort(&mut self, low: usize, start_arg: usize, high: usize) {
        let mut start = if low == start_arg {
            start_arg + 1
        } else {
            start_arg
        };
        while start < high {
            let (mut left, mut right) = (low, start);
            let pivot = self.a[start].clone();
            while left < right {
                let mid = left + ((right - left) >> 1);
                let m = self.a[mid].clone();
                if self.less(&pivot, &m) {
                    right = mid;
                } else {
                    left = mid + 1;
                }
            }
            self.a[left..=start].rotate_right(1);
            start += 1;
        }
    }

    fn len(&self, i: usize) -> usize {
        self.runs[i].1
    }

    fn invariant(&self, n: usize) -> bool {
        n < 2 || self.len(n - 2) > self.len(n - 1) + self.len(n)
    }

    fn merge_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if !self.invariant(n + 1) || !self.invariant(n) {
                if n > 0 && self.len(n - 1) < self.len(n + 1) {
                    n -= 1;
                }
                self.merge_at(n);
            } else if self.len(n) <= self.len(n + 1) {
                self.merge_at(n);
            } else {
                break;
            }
        }
    }

    fn merge_force_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if n > 0 && self.len(n - 1) < self.len(n + 1) {
                n -= 1;
            }
            self.merge_at(n);
        }
    }

    fn merge_at(&mut self, i: usize) {
        let (mut base_a, mut len_a) = self.runs[i];
        let (base_b, mut len_b) = self.runs[i + 1];
        self.runs[i].1 = len_a + len_b;
        self.runs.remove(i + 1);
        let key_right = self.a[base_b].clone();
        let k = self.gallop_right(Src::Array, &[], &key_right, base_a, len_a, 0);
        base_a += k;
        len_a -= k;
        if len_a == 0 {
            return;
        }
        let key_left = self.a[base_a + len_a - 1].clone();
        len_b = self.gallop_left(Src::Array, &[], &key_left, base_b, len_b, len_b - 1);
        if len_b == 0 {
            return;
        }
        if len_a <= len_b {
            self.merge_low(base_a, len_a, base_b, len_b);
        } else {
            self.merge_high(base_a, len_a, base_b, len_b);
        }
    }

    fn at(&self, src: Src, temp: &[T], i: usize) -> T {
        match src {
            Src::Array => self.a[i].clone(),
            Src::Temp => temp[i].clone(),
        }
    }

    /// Position `k` with `x[base + k - 1] < key <= x[base + k]`.
    fn gallop_left(
        &mut self,
        src: Src,
        temp: &[T],
        key: &T,
        base: usize,
        len: usize,
        hint: usize,
    ) -> usize {
        let (mut last_ofs, mut ofs) = (0usize, 1usize);
        let h = self.at(src, temp, base + hint);
        if self.less(&h, key) {
            let max_ofs = len - hint;
            while ofs < max_ofs {
                let e = self.at(src, temp, base + hint + ofs);
                if !self.less(&e, key) {
                    break;
                }
                last_ofs = ofs;
                ofs = (ofs << 1) + 1;
            }
            ofs = ofs.min(max_ofs);
            last_ofs += hint;
            ofs += hint;
        } else {
            let max_ofs = hint + 1;
            while ofs < max_ofs {
                let e = self.at(src, temp, base + hint - ofs);
                if self.less(&e, key) {
                    break;
                }
                last_ofs = ofs;
                ofs = (ofs << 1) + 1;
            }
            ofs = ofs.min(max_ofs);
            let tmp = last_ofs;
            // `hint - ofs` may be -1 here (the key belongs before everything); keep the arithmetic signed.
            let lo = hint as isize - ofs as isize;
            ofs = hint - tmp;
            return self.gallop_finish_left(src, temp, key, base, lo, ofs);
        }
        self.gallop_finish_left(src, temp, key, base, last_ofs as isize, ofs)
    }

    fn gallop_finish_left(
        &mut self,
        src: Src,
        temp: &[T],
        key: &T,
        base: usize,
        last: isize,
        mut ofs: usize,
    ) -> usize {
        let mut last = (last + 1) as usize;
        while last < ofs {
            let m = last + ((ofs - last) >> 1);
            let e = self.at(src, temp, base + m);
            if self.less(&e, key) {
                last = m + 1;
            } else {
                ofs = m;
            }
        }
        ofs
    }

    /// Position `k` with `x[base + k - 1] <= key < x[base + k]`.
    fn gallop_right(
        &mut self,
        src: Src,
        temp: &[T],
        key: &T,
        base: usize,
        len: usize,
        hint: usize,
    ) -> usize {
        let (mut last_ofs, mut ofs) = (0usize, 1usize);
        let h = self.at(src, temp, base + hint);
        let lo: isize;
        if self.less(key, &h) {
            let max_ofs = hint + 1;
            while ofs < max_ofs {
                let e = self.at(src, temp, base + hint - ofs);
                if !self.less(key, &e) {
                    break;
                }
                last_ofs = ofs;
                ofs = (ofs << 1) + 1;
            }
            ofs = ofs.min(max_ofs);
            let tmp = last_ofs;
            lo = hint as isize - ofs as isize;
            ofs = hint - tmp;
        } else {
            let max_ofs = len - hint;
            while ofs < max_ofs {
                let e = self.at(src, temp, base + hint + ofs);
                if self.less(key, &e) {
                    break;
                }
                last_ofs = ofs;
                ofs = (ofs << 1) + 1;
            }
            ofs = ofs.min(max_ofs);
            lo = (last_ofs + hint) as isize;
            ofs += hint;
        }
        let mut last = (lo + 1) as usize;
        while last < ofs {
            let m = last + ((ofs - last) >> 1);
            let e = self.at(src, temp, base + m);
            if self.less(key, &e) {
                ofs = m;
            } else {
                last = m + 1;
            }
        }
        ofs
    }

    fn merge_low(&mut self, base_a: usize, mut len_a: usize, base_b: usize, mut len_b: usize) {
        let temp: Vec<T> = self.a[base_a..base_a + len_a].to_vec();
        let (mut dest, mut ct, mut cb) = (base_a, 0usize, base_b);
        self.a[dest] = self.a[cb].clone();
        dest += 1;
        cb += 1;
        // Outcome: true = copy the rest of B then the last A element ("CopyB"), false = "Succeed".
        let copy_b = 'merge: {
            len_b -= 1;
            if len_b == 0 {
                break 'merge false;
            }
            if len_a == 1 {
                break 'merge true;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let (mut wins_a, mut wins_b) = (0usize, 0usize);
                loop {
                    let (b, t) = (self.a[cb].clone(), temp[ct].clone());
                    if self.less(&b, &t) {
                        self.a[dest] = b;
                        dest += 1;
                        cb += 1;
                        wins_b += 1;
                        len_b -= 1;
                        wins_a = 0;
                        if len_b == 0 {
                            break 'merge false;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    } else {
                        self.a[dest] = t;
                        dest += 1;
                        ct += 1;
                        wins_a += 1;
                        len_a -= 1;
                        wins_b = 0;
                        if len_a == 1 {
                            break 'merge true;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let key = self.a[cb].clone();
                    wins_a = self.gallop_right(Src::Temp, &temp, &key, ct, len_a, 0);
                    if wins_a > 0 {
                        self.a[dest..dest + wins_a].clone_from_slice(&temp[ct..ct + wins_a]);
                        dest += wins_a;
                        ct += wins_a;
                        len_a -= wins_a;
                        if len_a == 1 {
                            break 'merge true;
                        }
                        if len_a == 0 {
                            break 'merge false;
                        }
                    }
                    self.a[dest] = self.a[cb].clone();
                    dest += 1;
                    cb += 1;
                    len_b -= 1;
                    if len_b == 0 {
                        break 'merge false;
                    }
                    let key = temp[ct].clone();
                    wins_b = self.gallop_left(Src::Array, &[], &key, cb, len_b, 0);
                    if wins_b > 0 {
                        for i in 0..wins_b {
                            self.a[dest + i] = self.a[cb + i].clone();
                        }
                        dest += wins_b;
                        cb += wins_b;
                        len_b -= wins_b;
                        if len_b == 0 {
                            break 'merge false;
                        }
                    }
                    self.a[dest] = temp[ct].clone();
                    dest += 1;
                    ct += 1;
                    len_a -= 1;
                    if len_a == 1 {
                        break 'merge true;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        if copy_b {
            for i in 0..len_b {
                self.a[dest + i] = self.a[cb + i].clone();
            }
            self.a[dest + len_b] = temp[ct].clone();
        } else if len_a > 0 {
            self.a[dest..dest + len_a].clone_from_slice(&temp[ct..ct + len_a]);
        }
    }

    fn merge_high(&mut self, base_a: usize, mut len_a: usize, base_b: usize, mut len_b: usize) {
        let temp: Vec<T> = self.a[base_b..base_b + len_b].to_vec();
        // Cursors move right to left; signed because they can step one past the start.
        let mut dest = (base_b + len_b - 1) as isize;
        let mut ct = len_b as isize - 1;
        let mut ca = (base_a + len_a - 1) as isize;
        let at = |i: isize| i as usize;
        self.a[at(dest)] = self.a[at(ca)].clone();
        dest -= 1;
        ca -= 1;
        // Outcome: true = copy the rest of A then the first B element ("CopyA"), false = "Succeed".
        let copy_a = 'merge: {
            len_a -= 1;
            if len_a == 0 {
                break 'merge false;
            }
            if len_b == 1 {
                break 'merge true;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let (mut wins_a, mut wins_b) = (0usize, 0usize);
                loop {
                    let (t, a) = (temp[at(ct)].clone(), self.a[at(ca)].clone());
                    if self.less(&t, &a) {
                        self.a[at(dest)] = a;
                        dest -= 1;
                        ca -= 1;
                        wins_a += 1;
                        len_a -= 1;
                        wins_b = 0;
                        if len_a == 0 {
                            break 'merge false;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    } else {
                        self.a[at(dest)] = t;
                        dest -= 1;
                        ct -= 1;
                        wins_b += 1;
                        len_b -= 1;
                        wins_a = 0;
                        if len_b == 1 {
                            break 'merge true;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let key = temp[at(ct)].clone();
                    let k = self.gallop_right(Src::Array, &[], &key, base_a, len_a, len_a - 1);
                    wins_a = len_a - k;
                    if wins_a > 0 {
                        dest -= wins_a as isize;
                        ca -= wins_a as isize;
                        for i in (0..wins_a).rev() {
                            self.a[at(dest) + 1 + i] = self.a[at(ca) + 1 + i].clone();
                        }
                        len_a -= wins_a;
                        if len_a == 0 {
                            break 'merge false;
                        }
                    }
                    self.a[at(dest)] = temp[at(ct)].clone();
                    dest -= 1;
                    ct -= 1;
                    len_b -= 1;
                    if len_b == 1 {
                        break 'merge true;
                    }
                    let key = self.a[at(ca)].clone();
                    let k = self.gallop_left(Src::Temp, &temp, &key, 0, len_b, len_b - 1);
                    wins_b = len_b - k;
                    if wins_b > 0 {
                        dest -= wins_b as isize;
                        ct -= wins_b as isize;
                        let (d0, t0) = (at(dest + 1), at(ct + 1));
                        self.a[d0..d0 + wins_b].clone_from_slice(&temp[t0..t0 + wins_b]);
                        len_b -= wins_b;
                        if len_b == 1 {
                            break 'merge true;
                        }
                        if len_b == 0 {
                            break 'merge false;
                        }
                    }
                    self.a[at(dest)] = self.a[at(ca)].clone();
                    dest -= 1;
                    ca -= 1;
                    len_a -= 1;
                    if len_a == 0 {
                        break 'merge false;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        if copy_a {
            dest -= len_a as isize;
            ca -= len_a as isize;
            for i in (0..len_a).rev() {
                self.a[at(dest + 1) + i] = self.a[at(ca + 1) + i].clone();
            }
            self.a[at(dest)] = temp[at(ct)].clone();
        } else if len_b > 0 {
            let d0 = at(dest - (len_b as isize - 1));
            self.a[d0..d0 + len_b].clone_from_slice(&temp[..len_b]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *seed >> 33
    }

    #[test]
    fn sorts_like_a_stable_sort_for_total_orders() {
        let mut seed = 9;
        for n in [0usize, 1, 2, 5, 63, 64, 65, 200, 1000, 5000] {
            let v: Vec<(u64, usize)> = (0..n).map(|i| (lcg(&mut seed) % 50, i)).collect();
            let mut ours = v.clone();
            sort_by(&mut ours, |a, b| a.0.cmp(&b.0));
            let mut std_sorted = v.clone();
            std_sorted.sort_by_key(|x| x.0);
            assert_eq!(ours, std_sorted, "n = {n}");
        }
        // Long ascending / descending runs and galloping-friendly data.
        let mut v: Vec<(u64, usize)> = (0..3000).map(|i| ((i % 700) as u64, i)).collect();
        v.extend((0..900).rev().map(|i| (i as u64 / 3, 4000 + i)));
        let mut ours = v.clone();
        sort_by(&mut ours, |a, b| a.0.cmp(&b.0));
        v.sort_by_key(|x| x.0);
        assert_eq!(ours, v);
    }

    #[test]
    fn never_panics_on_inconsistent_comparators() {
        let mut seed = 3;
        for n in [3usize, 20, 64, 100, 700, 3000] {
            let mut v: Vec<u64> = (0..n).map(|_| lcg(&mut seed) % 1000).collect();
            let mut s2 = 11u64;
            sort_by(&mut v, |_, _| match lcg(&mut s2) % 3 {
                0 => Ordering::Less,
                1 => Ordering::Equal,
                _ => Ordering::Greater,
            });
            assert_eq!(v.len(), n);
        }
    }

    /// Golden orders produced by V8 (`node -e`) for a non-transitive comparator ("within 25 counts as equal,
    /// otherwise by value"), so the port keeps matching JavaScript where every stable sort would disagree.
    #[test]
    fn matches_v8_for_a_non_transitive_comparator() {
        let near = |a: &i64, b: &i64| {
            let d = (a - b) as f64;
            if d.abs() > 25.0 {
                js_order(d)
            } else {
                Ordering::Equal
            }
        };
        let mut seed = 42;
        let mut v: Vec<i64> = (0..80).map(|_| (lcg(&mut seed) % 400) as i64).collect();
        let input = v.clone();
        sort_by(&mut v, near);
        assert_eq!(input.len(), 80);
        assert_eq!(v, V8_GOLDEN_80.to_vec(), "input {input:?}");
    }

    const V8_GOLDEN_80: [i64; 80] = [
        22, 5, 7, 20, 46, 28, 20, 16, 82, 57, 65, 55, 36, 134, 125, 104, 114, 108, 114, 93, 88,
        156, 134, 169, 160, 148, 159, 144, 188, 193, 226, 210, 190, 194, 173, 183, 196, 249, 226,
        231, 231, 237, 223, 214, 223, 252, 262, 261, 303, 294, 310, 309, 299, 295, 286, 285, 274,
        288, 338, 317, 312, 366, 344, 346, 333, 315, 309, 345, 347, 331, 332, 326, 390, 369, 361,
        357, 395, 378, 355, 387,
    ];
}
