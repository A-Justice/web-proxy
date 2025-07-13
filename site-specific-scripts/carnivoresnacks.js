document.addEventListener("DOMContentLoaded", (e) => {
    if (
      convert.currentData?.experiences?.[1004115659] &&
      convert.currentData?.experiences?.[1004115659]?.variation &&
      convert.currentData?.experiences?.[1004115659]?.variation?.id === "1004275200"
    ) {
      var comparisonImage = document.querySelector(
        ".rtnu-comparison-table__mobile"
      );
      var targetElement = document.querySelector(
        "#pdp-main-carousel .splide__list"
      );
      var thumbnailsList = document.querySelector(
        ".rtnu-product__thumbails .splide__list"
      );
      var comparisonWrapper = document.querySelector(
        ".rtnu-comparison-table__wrapper"
      );
  
      if (comparisonImage && targetElement) {
        var imgSrc = comparisonImage.getAttribute("src");
  
        if (imgSrc) {
          var newListItem = document.createElement("li");
          newListItem.className = "splide__slide";
  
          var newImg = document.createElement("img");
          newImg.setAttribute("src", imgSrc);
          newImg.setAttribute("alt", comparisonImage.getAttribute("alt") || "");
          newImg.setAttribute("data-image-id", "comparison-image");
          newImg.classList.add("comparison-image");
          newListItem.appendChild(newImg);
          targetElement.appendChild(newListItem);
        }
      }
  
      if (comparisonWrapper && thumbnailsList && comparisonImage) {
        var imgSrc = comparisonImage.getAttribute("src");
  
        if (imgSrc) {
          var thumbnailListItem = document.createElement("li");
          thumbnailListItem.className = "splide__slide";
  
          var thumbnailImg = document.createElement("img");
          thumbnailImg.setAttribute("src", imgSrc);
          thumbnailImg.setAttribute(
            "alt",
            comparisonImage.getAttribute("alt") || ""
          );
          thumbnailImg.setAttribute("data-image-id", "comparison-image");
          thumbnailListItem.appendChild(thumbnailImg);
          thumbnailsList.appendChild(thumbnailListItem);
        }
      }
    }
  
    let productForm = document.querySelector(
        "#rtnu-product-form-template--20005210751216__main"
      ),
      currentVariantPrice = "$39.97",
      shippingFrequencyDropdown = productForm.querySelector(
        ".rtnu-single-option-selector__dropdown"
      ),
      subscriptionBenefits = productForm.querySelector(
        ".rtnu-product__subscription-benefits"
      ),
      productVariantsSelectBtn = productForm.querySelector(
        ".rtnu-product__variants-select-btn"
      ),
      productVariantsSelectDropdown = productForm.querySelector(
        ".rtnu-product__variants-select-dropdown"
      ),
      productVariantSelectOption = productForm.querySelectorAll(
        ".rtnu-product__variants-select-dropdown-item"
      ),
      productVariantsOptions = productForm.querySelectorAll(
        ".rtnu-product__variants .rtnu-option"
      ),
      subscriptionPrice = productForm.querySelector(
        ".rtnu-single-option__price--subscription"
      ),
      onetimePrice = productForm.querySelector(
        ".rtnu-single-option__price--onetime div"
      ),
      sellingPlan = productForm.querySelector(
        "#rtnu-product-form-template--20005210751216__main-sellingPlan"
      ),
      productId = productForm.querySelector('[name="id"]'),
      sellingPlanOptions = productForm.querySelector(
        "#rtnu-product-form-template--20005210751216__main-sellingPlanOptions"
      ),
      carouselSlides = document.querySelectorAll(
        "#pdp-main-carousel .splide__slide"
      ),
      purchaseSelectorLabel = productForm.querySelectorAll(
        "#rtnu-product-form-template--20005210751216__main-ProductSelect-option-1 label"
      ),
      priceWOz = document.querySelector(".rtnu-product__price-w-oz"),
      priceWOzPrice = document.querySelectorAll(
        ".rtnu-product__price-w-oz__price"
      ),
      priceWOzPerOz = document.querySelectorAll(
        ".rtnu-product__price-w-oz__oz span"
      ),
      modalBtn = document.querySelector(".rtnu-btn--modal");
  
    // Product Slider
    var main = new Splide("#pdp-main-carousel", {
      type: "slide",
      rewind: true,
      pagination: false,
      arrows: false,
      gap: 16,
    });
  
    var thumbnails = new Splide("#pdp-main-thumbnails", {
      fixedWidth: 70,
      fixedHeight: 70,
      gap: 10,
      rewind: false,
      pagination: false,
      arrowPath:
        "m21.9531 20.0008-8.25-8.25 2.3567-2.35671L26.6665 20.0008 16.0598 30.6074l-2.3567-2.3566 8.25-8.25Z",
      isNavigation: true,
      breakpoints: {
        900: {
          fixedWidth: 60,
          fixedHeight: 60,
          perPage: 3,
        },
        600: {
          fixedWidth: 50,
          fixedHeight: 50,
          perPage: 2,
          gap: 8,
        },
      },
    });
  
    main.sync(thumbnails);
    main.mount();
    thumbnails.mount();
  
    // handle radio group variants
    if (
      typeof productVariantsOptions !== undefined &&
      productVariantsOptions !== null
    ) {
      productVariantsOptions.forEach((variant) => {
        let first_variant_price,
          variant_raw_price = variant.querySelector("input[type='radio']").dataset
            .priceRaw,
          variant_raw_sub_price = variant.querySelector("input[type='radio']")
            .dataset.subPriceRaw,
          variant_price = variant.querySelector("input[type='radio']").dataset
            .price,
          variant_sub_price = variant.querySelector("input[type='radio']").dataset
            .subPrice;
        (item_count = variant.querySelector("input[type='radio']").dataset
          .itemCount),
          (subPricePerOz = variant.querySelector("input[type='radio']").dataset
            .subPricePerOz),
          (onetimePricePerOz = variant.querySelector("input[type='radio']")
            .dataset.onetimePricePerOz);
  
        if (variant.querySelector("input[type='radio']:checked")) {
          first_variant_price = variant.querySelector(
            "input[type='radio']:checked"
          ).dataset.price;
          first_variant_sub_price = variant.querySelector(
            "input[type='radio']:checked"
          ).dataset.subPrice;
          priceWOzPrice.forEach((price) => {
            price.innerHTML = first_variant_sub_price;
          });
  
          priceWOzPerOz.forEach((price) => {
            price.innerHTML = subPricePerOz;
          });
        }
  
        // handle product variant selection
        variant.addEventListener("change", (e) => {
          let variant_id = e.target.value,
            variant_subscription_id = e.target.dataset.subId,
            variant_price = e.target.dataset.price,
            variant_subscription_price = e.target.dataset.subPrice,
            variant_sub_discount = e.target.dataset.subDiscount,
            variant_sub_price_per_oz = e.target.dataset.subPricePerOz,
            variant_onetime_price_per_oz = e.target.dataset.onetimePricePerOz;
  
          // Update one time price and subscription price when variant is changed
          onetimePrice.innerHTML = variant_price;
          subscriptionPrice.querySelector("del").innerHTML = variant_price;
          subscriptionPrice.querySelector("div").innerHTML =
            variant_subscription_price;
  
          priceWOzPrice.forEach((price) => {
            price.innerHTML = variant_subscription_price;
          });
  
          priceWOzPerOz.forEach((price) => {
            price.innerHTML = variant_sub_price_per_oz;
          });
          productId.value = variant_id;
  
          // if rtnu-single-option--purchaseType-one-time is checked, update prizeWOzPrice and priceWOzPerOz
          if (
            productForm.querySelector(
              ".rtnu-single-option--purchaseType-one-time"
            ).checked
          ) {
            priceWOzPrice.forEach((price) => {
              price.innerHTML = variant_price;
            });
  
            priceWOzPerOz.forEach((price) => {
              price.innerHTML = variant_onetime_price_per_oz;
            });
          }
  
          // Update carousel slides to match variant
          carouselSlides.forEach((slide, index) => {
            let slide_variant_id = slide.dataset.variant;
  
            if (slide_variant_id !== undefined) {
              if (variant_id == slide_variant_id) {
                main.go(index);
              }
            }
          });
        });
      });
    }
  
    // handle dropdown variants
    if (
      typeof productVariantsSelectBtn !== undefined &&
      productVariantsSelectBtn !== null
    ) {
      productVariantsSelectBtn.addEventListener("click", (e) => {
        e.preventDefault();
  
        e.target.classList.toggle("toggle");
        const next = e.target.nextElementSibling;
        next.classList.toggle("toggle");
      });
  
      productVariantSelectOption.forEach((option) => {
        option.addEventListener("click", (e) => {
          e.preventDefault();
  
          const parent = e.target.closest(".rtnu-product__variants-select")
              .children[0],
            selectedOption = e.target,
            selectedOptionType = selectedOption.getAttribute("data-type"),
            selectedOptionID = selectedOption.getAttribute("data-id"),
            selectedOptionSubID = selectedOption.getAttribute("data-sub-id"),
            selectedOptionPrice = selectedOption.getAttribute("data-price"),
            selectedOptionSubPrice =
              selectedOption.getAttribute("data-sub-price"),
            selectedOptionSubPriceRaw =
              selectedOption.getAttribute("data-sub-price-raw"),
            selectedOptionPriceRaw =
              selectedOption.getAttribute("data-price-raw"),
            selectedOptionSubDiscount =
              selectedOption.getAttribute("data-sub-discount"),
            selectedOptionPricePerOz = selectedOption.getAttribute(
              "data-onetime-price-per-oz"
            ),
            selectedOptionSubPricePerOz = selectedOption.getAttribute(
              "data-sub-price-per-oz"
            );
  
          e.target.parentElement.classList.remove("toggle");
          parent.classList.remove("toggle");
          parent.setAttribute("data-type", selectedOptionType);
          parent.innerText = selectedOption.innerText;
  
          // Update product ID value with the selected variant ID
          productId.value = selectedOptionID;
  
          // Update price and price per oz near the product title
          priceWOzPrice.forEach((price) => {
            price.innerHTML = selectedOptionSubPrice;
          });
  
          priceWOzPerOz.forEach((price) => {
            price.innerHTML = selectedOptionSubPricePerOz;
          });
  
          // Update one time price and subscription price when variant is changed
          onetimePrice.innerHTML = selectedOptionPrice;
  
          // Update Purchase Selector
  
          subscriptionPrice.querySelector("del").innerHTML = selectedOptionPrice;
          subscriptionPrice.querySelector("div").innerHTML =
            selectedOptionSubPrice;
  
          priceWOzPrice.forEach((price) => {
            price.innerHTML = selectedOptionSubPrice;
          });
  
          priceWOzPerOz.forEach((price) => {
            price.innerHTML = selectedOptionSubPricePerOz;
          });
  
          // if rtnu-single-option--purchaseType-one-time is checked, update prizeWOzPrice and priceWOzPerOz
          if (
            productForm.querySelector(
              ".rtnu-single-option--purchaseType-one-time"
            ).checked
          ) {
            priceWOzPrice.forEach((price) => {
              price.innerHTML = selectedOptionPrice;
            });
  
            priceWOzPerOz.forEach((price) => {
              price.innerHTML = selectedOptionPricePerOz;
            });
          }
  
          // Update carousel slides to match variant
          carouselSlides.forEach((slide, index) => {
            let slide_variant_id = slide.dataset.variant;
  
            if (slide_variant_id !== undefined) {
              if (selectedOptionID == slide_variant_id) {
                main.go(index);
              }
            }
          });
        });
      });
  
      // Close dropdown when clicking outside of the dropdown container
      document.addEventListener("click", (e) => {
        if (e.target.closest(".rtnu-product__variants-select") === null) {
          productVariantsSelectBtn.classList.remove("toggle");
          productVariantsSelectDropdown.classList.remove("toggle");
        }
      });
    }
  
    // handle purchase type
    if (
      typeof purchaseSelectorLabel !== undefined &&
      purchaseSelectorLabel !== null
    ) {
      purchaseSelectorLabel.forEach((label) => {
        let labelParent = label.parentNode;
  
        if (
          typeof productVariantsOptions !== undefined &&
          productVariantsOptions !== null
        ) {
          productVariantsOptions.forEach((variant) => {
            let variant_raw_price = variant.querySelector("input[type='radio']")
                .dataset.priceRaw,
              variant_raw_sub_price = variant.querySelector("input[type='radio']")
                .dataset.subPriceRaw,
              item_count = variant.querySelector("input[type='radio']").dataset
                .itemCount,
              variant_sub_price_per_oz = variant.querySelector(
                "input[type='radio']"
              ).dataset.subPricePerOz,
              variant_onetime_price_per_oz = variant.querySelector(
                "input[type='radio']"
              ).dataset.onetimePricePerOz;
          });
        }
  
        label.addEventListener("click", (e) => {
          let is_subscription;
          //remove active class from all purchase selector labels and add to clicked label
          purchaseSelectorLabel.forEach((i) => {
            i.parentNode.classList.remove("rtnu-custom-radio--active");
            i.parentNode.querySelector("input").checked = false;
          });
  
          labelParent.classList.add("rtnu-custom-radio--active");
          labelParent.querySelector("input").checked = true;
  
          if (label.classList.contains("purchaseType-subscription")) {
            is_subscription = true;
          } else {
            is_subscription = false;
          }
  
          if (is_subscription) {
            shippingFrequencyDropdown.style.display = "flex";
            subscriptionBenefits.style.display = "block";
            sellingPlan.setAttribute("name", "selling_plan");
  
            // update priceWOzPrice and priceWOzPerOz with checked productVariantsOption
            if (
              typeof productVariantsOptions !== undefined &&
              productVariantsOptions !== null
            ) {
              productVariantsOptions.forEach((variant) => {
                let variant_raw_price = variant.querySelector(
                    "input[type='radio']"
                  ).dataset.priceRaw,
                  variant_raw_sub_price = variant.querySelector(
                    "input[type='radio']"
                  ).dataset.subPriceRaw,
                  item_count = variant.querySelector("input[type='radio']")
                    .dataset.itemCount,
                  variant_sub_price_per_oz = variant.querySelector(
                    "input[type='radio']"
                  ).dataset.subPricePerOz,
                  variant_onetime_price_per_oz = variant.querySelector(
                    "input[type='radio']"
                  ).dataset.onetimePricePerOz;
  
                if (variant.querySelector("input[type='radio']:checked")) {
                  priceWOzPrice.forEach((price) => {
                    price.innerHTML = variant.querySelector(
                      "input[type='radio']:checked"
                    ).dataset.subPrice;
                  });
  
                  priceWOzPerOz.forEach((price) => {
                    price.innerHTML = variant_sub_price_per_oz;
                  });
                }
              });
            }
  
            if (
              typeof document.querySelector(".rtnu-product__variants") ===
                undefined ||
              document.querySelector(".rtnu-product__variants") === null
            ) {
              priceWOzPrice.forEach((price) => {
                price.innerHTML = label.dataset.subPrice;
              });
  
              priceWOzPerOz.forEach((price) => {
                price.innerHTML = label.dataset.subPricePerOz;
              });
            }
          } else {
            shippingFrequencyDropdown.style.display = "none";
            subscriptionBenefits.style.display = "none";
            sellingPlan.setAttribute("name", "");
  
            // update priceWOzPrice and priceWOzPerOz with checked one-time productVariantsOption
            if (
              typeof productVariantsOptions !== undefined &&
              productVariantsOptions !== null
            ) {
              productVariantsOptions.forEach((variant) => {
                let variant_raw_price = variant.querySelector(
                    "input[type='radio']"
                  ).dataset.priceRaw,
                  variant_raw_sub_price = variant.querySelector(
                    "input[type='radio']"
                  ).dataset.subPriceRaw,
                  item_count = variant.querySelector("input[type='radio']")
                    .dataset.itemCount,
                  variant_sub_price_per_oz = variant.querySelector(
                    "input[type='radio']"
                  ).dataset.subPricePerOz,
                  variant_onetime_price_per_oz = variant.querySelector(
                    "input[type='radio']"
                  ).dataset.onetimePricePerOz;
  
                if (variant.querySelector("input[type='radio']:checked")) {
                  priceWOzPrice.forEach((price) => {
                    price.innerHTML = variant.querySelector(
                      "input[type='radio']:checked"
                    ).dataset.price;
                  });
  
                  priceWOzPerOz.forEach((price) => {
                    price.innerHTML = variant_onetime_price_per_oz;
                  });
                }
              });
            }
  
            if (
              typeof document.querySelector(".rtnu-product__variants") ===
                undefined ||
              document.querySelector(".rtnu-product__variants") === null
            ) {
              priceWOzPrice.forEach((price) => {
                price.innerHTML = label.dataset.price;
              });
  
              priceWOzPerOz.forEach((price) => {
                price.innerHTML = label.dataset.onetimePricePerOz;
              });
            }
          }
  
          // update single item price when purchase type is changed
          if (
            typeof productVariantsOptions !== undefined &&
            productVariantsOptions !== null
          ) {
            productVariantsOptions.forEach((variant) => {
              let variant_raw_price = variant.querySelector("input[type='radio']")
                  .dataset.priceRaw,
                variant_raw_sub_price = variant.querySelector(
                  "input[type='radio']"
                ).dataset.subPriceRaw,
                item_count = variant.querySelector("input[type='radio']").dataset
                  .itemCount;
            });
          }
        });
      });
    }
  
    // handle shipping frequency selection
    if (typeof sellingPlanOptions !== undefined && sellingPlanOptions !== null) {
      sellingPlanOptions.addEventListener("change", (e) => {
        let shipping_frequency = e.target.value;
        sellingPlan.value = shipping_frequency;
      });
    }
  
    // check if modalBtn exists and then attach an event listener for the click event. After it is clicked, trigger a click on the element with class 'is-close-btn'
    if (typeof modalBtn !== undefined && modalBtn !== null) {
      modalBtn.addEventListener("click", (e) => {
        document.querySelector(".is-close-btn").click();
      });
    }
  });
  