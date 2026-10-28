//! Id generation. Ids are 12 chars `[a-z0-9]` (nanoid alphabet, lowercase + digits); `"root"` is reserved.
//!
//! The core never reads system randomness (it must run on `wasm32-unknown-unknown` without JS glue), so callers
//! inject a generator: [`RandomIds`] seeded from the platform CSPRNG by the host, or [`SequentialIds`] for tests.

/// Id alphabet (same as `@desyn/schema` `newId()`).
pub const ID_ALPHABET: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";
/// Id length.
pub const ID_LENGTH: usize = 12;

/// Source of fresh ids.
pub trait IdGen {
    /// Returns a new id (12 chars `[a-z0-9]`).
    fn next_id(&mut self) -> String;
}

impl<F: FnMut() -> String> IdGen for F {
    fn next_id(&mut self) -> String {
        self()
    }
}

/// Deterministic ids `<prefix><counter>` padded with zeros to 12 chars, e.g. `"n00000000001"`.
#[derive(Debug, Clone)]
pub struct SequentialIds {
    prefix: String,
    next: u64,
}

impl SequentialIds {
    /// Generator with a lowercase alphanumeric prefix (at most 11 chars; extra chars are cut).
    pub fn new(prefix: &str) -> Self {
        let prefix: String = prefix
            .chars()
            .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            .take(ID_LENGTH - 1)
            .collect();
        SequentialIds { prefix, next: 1 }
    }
}

impl IdGen for SequentialIds {
    fn next_id(&mut self) -> String {
        let n = self.next;
        self.next += 1;
        let width = ID_LENGTH - self.prefix.len();
        let digits = format!("{n:0width$}");
        // Wrap around (never longer than 12 chars) - 10^width ids per prefix is far beyond practical use.
        let digits = &digits[digits.len() - width..];
        format!("{}{}", self.prefix, digits)
    }
}

/// Seeded pseudo-random ids (xoshiro256**), uniformly distributed over the alphabet. Seed it from a CSPRNG
/// (e.g. `crypto.getRandomValues`) to get collision resistance comparable to `newId()`.
#[derive(Debug, Clone)]
pub struct RandomIds {
    s: [u64; 4],
}

impl RandomIds {
    /// Generator from a 256-bit seed (all-zero seeds are remapped).
    pub fn from_seed(seed: [u64; 4]) -> Self {
        let mut s = seed;
        if s == [0; 4] {
            s = [
                0x9E37_79B9_7F4A_7C15,
                0xBF58_476D_1CE4_E5B9,
                0x94D0_49BB_1331_11EB,
                0x2545_F491_4F6C_DD1D,
            ];
        }
        RandomIds { s }
    }

    /// Generator from a 64-bit seed expanded with splitmix64.
    pub fn from_u64(seed: u64) -> Self {
        let mut x = seed;
        let mut next = || {
            x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = x;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        };
        Self::from_seed([next(), next(), next(), next()])
    }

    fn next_u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }
}

impl IdGen for RandomIds {
    fn next_id(&mut self) -> String {
        let mut out = String::with_capacity(ID_LENGTH);
        while out.len() < ID_LENGTH {
            let mut v = self.next_u64();
            for _ in 0..8 {
                let byte = (v & 0xff) as u8;
                v >>= 8;
                // Reject bytes >= 252 so every symbol is equally likely (as in `newId()`).
                if byte < 252 {
                    out.push(ID_ALPHABET[(byte % 36) as usize] as char);
                    if out.len() == ID_LENGTH {
                        break;
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::is_id;

    #[test]
    fn sequential() {
        let mut g = SequentialIds::new("n");
        assert_eq!(g.next_id(), "n00000000001");
        assert_eq!(g.next_id(), "n00000000002");
        assert!(is_id(&SequentialIds::new("Hello-World!").next_id()));
    }

    #[test]
    fn random_is_valid_and_distinct() {
        let mut g = RandomIds::from_u64(42);
        let ids: Vec<String> = (0..1000).map(|_| g.next_id()).collect();
        assert!(ids.iter().all(|i| is_id(i)));
        let set: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(set.len(), 1000);
        assert_eq!(RandomIds::from_u64(42).next_id(), ids[0]);
    }
}
